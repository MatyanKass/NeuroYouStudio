import type { PredictionConfig } from '@shared/config'
import type {
  Attachment,
  ChatDelta,
  ChatMessage,
  Conversation,
  GenerateRequest,
  GenerationStats,
  MessageVersion,
  StopReason
} from '@shared/types'
import { activeEngine, type ActiveEngine } from '../engines/manager'
import { authHeaders } from '../engines/auth'
import { emit } from '../ipc'
import { getSettings } from '../settings'
import { newId } from '../util/id'
import { assertStoredAttachment, imageDataUrl } from '../attachments'
import { extractDocumentText } from '../attachments/extract'
import { buildDocumentContext } from '../attachments/documents'
import { fitHistory, type CountedMessage } from './context'
import { buildSamplingParams } from './params'
import { SseParser } from './sse'
import { ThinkSplitter } from './think'
import { countTokens } from './tokens'
import { getConversation, keepFinishedVersions, saveConversation, titleFromText } from './store'
import { runAgentStream } from '../agent/loop'

type OpenAiContent = string | Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }>
interface OpenAiMessage {
  role: 'system' | 'user' | 'assistant'
  content: OpenAiContent
}

const IMAGE_TOKENS_ESTIMATE = 768

/** Текст документа — только из папки вложений (путь в файле диалога мог быть изменён). */
async function storedDocumentText(a: Attachment): Promise<string> {
  assertStoredAttachment(a)
  return extractDocumentText(a)
}

interface Running {
  controller: AbortController
  conversationId: string
  messageId: string
  /** Версия ответа, в которую пишет стрим (живой объект). */
  versionIndex: number
  version: MessageVersion | null
  /** Само сообщение ответа (живой объект). */
  message: ChatMessage | null
}

let running: Running | null = null

export const isGenerating = (): boolean => running !== null
export const generatingConversationId = (): string | null => running?.conversationId ?? null

export function stopGeneration(): void {
  running?.controller.abort()
}

const activeText = (m: ChatMessage): string => m.versions[m.activeVersion]?.content ?? ''

/**
 * Сохранение диалога из интерфейса (chat:save). Интерфейс присылает свою копию, в которой ответ,
 * генерирующийся прямо сейчас, может быть неполным, — подставляем живую версию из стрима,
 * а завершённые ответы не даём затереть устаревшим снимком.
 */
export function reconcileIncoming(c: Conversation, cached: Conversation | null): Conversation {
  keepFinishedVersions(c, cached)
  const r = running
  if (!r?.version || c.id !== r.conversationId) return c
  const msg = c.messages.find((m) => m.id === r.messageId)
  if (!msg) {
    // Интерфейс не даёт удалить сообщение, в которое идёт генерация, — значит, это снимок,
    // сделанный до появления ответа: ответ возвращаем.
    if (r.message) c.messages.push(r.message)
    return c
  }
  putVersion(msg, r.versionIndex, r.version)
  return c
}

/** Ставит живую версию ответа на её место (или дописывает, если снимок сделан до её появления). */
function putVersion(msg: ChatMessage, index: number, version: MessageVersion): void {
  const v = msg.versions[index]
  if (v && v.createdAt === version.createdAt) msg.versions[index] = version
  else if (!v && index === msg.versions.length) {
    msg.versions.push(version)
    msg.activeVersion = index
  }
}

/** Что генерация поменяла в истории (документы): применяется к свежей копии диалога при сохранении. */
interface HistoryPatch {
  messageId: string
  citations?: ChatMessage['citations']
  injection: Record<string, 'full' | 'rag'>
}

/** Сообщения истории → формат OpenAI (с картинками и документами). */
async function toOpenAi(
  history: ChatMessage[],
  eng: ActiveEngine,
  docBudgetTokens: number,
  patches: HistoryPatch[]
): Promise<{ messages: OpenAiMessage[]; counts: CountedMessage[] }> {
  const maxDim = getSettings().imageMaxDimension
  const messages: OpenAiMessage[] = []
  const counts: CountedMessage[] = []
  let lastUser = -1
  history.forEach((m, i) => {
    if (m.role === 'user') lastUser = i
  })
  for (let i = 0; i < history.length; i++) {
    const m = history[i]!
    if (m.role === 'system') continue
    let text = activeText(m)
    const atts = m.attachments ?? []
    const docs = atts.filter((a) => a.kind === 'document')
    const images = atts.filter((a) => a.kind === 'image')
    const isLast = i === history.length - 1
    if (docs.length) {
      // Документы последнего сообщения получают полный бюджет, старые — четверть.
      const budget = isLast ? docBudgetTokens : Math.floor(docBudgetTokens / 4)
      try {
        const ctx = await buildDocumentContext(docs, text, budget, eng, storedDocumentText)
        if (isLast) {
          patches.push({
            messageId: m.id,
            citations: ctx.citations.length ? ctx.citations : undefined,
            injection: Object.fromEntries(docs.map((a) => [a.id, ctx.mode]))
          })
        }
        text = `${ctx.text}\n\n${text}`
      } catch (e) {
        // Пропавший файл старого сообщения не должен ломать весь диалог.
        if (isLast) throw e
        text = `${docs.map((a) => `[Документ «${a.name}» недоступен]`).join('\n')}\n\n${text}`
      }
    }
    let tokens = (await countTokens(eng, text)) + 8
    let content: OpenAiContent = text
    if (images.length && m.role === 'user') {
      if (eng.vision) {
        const parts: Exclude<OpenAiContent, string> = []
        for (const img of images) {
          try {
            parts.push({ type: 'image_url', image_url: { url: await imageDataUrl(img, maxDim) } })
          } catch (e) {
            // Пропавшая картинка старого сообщения не должна ломать весь диалог.
            if (i === lastUser) throw e
          }
        }
        if (parts.length) {
          tokens += parts.length * IMAGE_TOKENS_ESTIMATE
          parts.push({ type: 'text', text })
          content = parts
        }
      } else if (i === lastUser) {
        throw new Error('Загруженная модель не поддерживает изображения. Выберите vision-модель (с файлом mmproj).')
      }
      // Картинки из старых сообщений модель без зрения просто не видит.
    }
    messages.push({ role: m.role, content })
    counts.push({ role: m.role, tokens })
  }
  return { messages, counts }
}

export function mapStopReason(
  finish: string | null | undefined,
  aborted: boolean,
  p: PredictionConfig,
  completionTokens: number
): StopReason {
  if (aborted) return 'userStopped'
  if (finish === 'length') {
    return p.maxTokens.enabled && completionTokens >= p.maxTokens.value
      ? 'maxPredictedTokensReached'
      : 'contextLengthReached'
  }
  return 'eosFound'
}

interface StreamChunk {
  choices?: Array<{
    delta?: { content?: string | null; reasoning_content?: string | null; reasoning?: string | null }
    finish_reason?: string | null
  }>
  usage?: { prompt_tokens?: number; completion_tokens?: number }
  timings?: {
    prompt_n?: number
    prompt_per_second?: number
    predicted_n?: number
    predicted_per_second?: number
    draft_n?: number
    draft_n_accepted?: number
  }
  error?: { message?: string } | string
}

export async function generate(req: GenerateRequest): Promise<void> {
  if (running) throw new Error('Генерация уже идёт')
  const eng = activeEngine()
  if (!eng) throw new Error('Сначала загрузите модель')
  // Слот занимаем сразу: второй запрос, пришедший во время await ниже, получит «уже идёт».
  const controller = new AbortController()
  const slot: Running = {
    controller,
    conversationId: req.conversationId,
    messageId: '',
    versionIndex: 0,
    version: null,
    message: null
  }
  running = slot
  try {
    await startGeneration(req, eng, slot)
  } catch (e) {
    if (running === slot) running = null
    throw e
  }
}

async function startGeneration(req: GenerateRequest, eng: ActiveEngine, slot: Running): Promise<void> {
  const conv = await getConversation(req.conversationId)
  if (!conv) throw new Error('Диалог не найден')
  const p = req.prediction

  // Целевое сообщение ассистента и история до него.
  let target: ChatMessage
  let history: ChatMessage[]
  let continuing = false
  if (req.regenerateMessageId) {
    const idx = conv.messages.findIndex((m) => m.id === req.regenerateMessageId)
    if (idx < 0) throw new Error('Сообщение не найдено')
    target = conv.messages[idx]!
    if (target.role !== 'assistant') throw new Error('Перегенерировать можно только ответ модели')
    history = conv.messages.slice(0, idx)
    target.versions.push({ content: '', createdAt: Date.now(), modelId: eng.modelId })
    target.activeVersion = target.versions.length - 1
    conv.messages = conv.messages.slice(0, idx + 1)
  } else if (req.continueMessageId) {
    const idx = conv.messages.findIndex((m) => m.id === req.continueMessageId)
    if (idx < 0) throw new Error('Сообщение не найдено')
    target = conv.messages[idx]!
    if (target.role !== 'assistant') throw new Error('Продолжить можно только ответ модели')
    history = conv.messages.slice(0, idx + 1)
    const v = target.versions[target.activeVersion]
    if (!v) throw new Error('Сообщение не найдено')
    // Прошлая ошибка к продолжению не относится.
    delete v.error
    continuing = v.content.length > 0
  } else {
    if (!conv.messages.some((m) => m.role === 'user')) throw new Error('Нет сообщения, на которое нужно ответить')
    target = {
      id: newId('m'),
      role: 'assistant',
      versions: [{ content: '', createdAt: Date.now(), modelId: eng.modelId }],
      activeVersion: 0
    }
    history = [...conv.messages]
    conv.messages.push(target)
  }
  if (conv.title === 'Новый чат') {
    const firstUser = conv.messages.find((m) => m.role === 'user')
    if (firstUser) conv.title = titleFromText(activeText(firstUser))
  }
  slot.messageId = target.id
  slot.versionIndex = target.activeVersion
  slot.version = target.versions[target.activeVersion]!
  slot.message = target
  const saved = await saveConversation(conv)
  if (!saved) throw new Error('Диалог удалён')
  emit('chat:updated', saved)
  // Пустая дельта сразу: интерфейс показывает «обрабатываю промпт», пока нет первого токена.
  emit('chat:delta', { conversationId: conv.id, messageId: target.id })

  // Остальное — асинхронно, результат приходит событиями chat:delta / chat:updated.
  const task = conv.agent?.enabled
    ? runAgentStream({
        convId: conv.id,
        target,
        history,
        eng,
        prediction: p,
        version: slot.version,
        versionIndex: slot.versionIndex,
        controller: slot.controller,
        cwd: conv.agent.cwd,
        allowAll: conv.agent.allowAll === true
      })
    : runStream(conv.id, target, history, eng, p, slot, continuing)
  void task
    .catch((e: unknown) => console.error('[chat] сбой генерации:', e))
    .finally(() => {
      if (running === slot) running = null
    })
}

/**
 * «Продолжить»: последнее сообщение ассистента — начало ответа, которое модель дописывает.
 * llama-server дописывает его сам (prefill), но только без режима рассуждений;
 * TabbyAPI закрыл бы реплику шаблоном — ему начало передаётся как response_prefix.
 */
export function continuationParams(
  body: Record<string, unknown>,
  engine: ActiveEngine['engine'],
  messages: OpenAiMessage[]
): Record<string, unknown> {
  if (engine === 'exl3') {
    const last = messages[messages.length - 1]
    if (last?.role !== 'assistant' || typeof last.content !== 'string') return {}
    messages.pop()
    return { response_prefix: last.content, add_generation_prompt: true }
  }
  const kwargs = (body.chat_template_kwargs as Record<string, unknown> | undefined) ?? {}
  return { chat_template_kwargs: { ...kwargs, enable_thinking: false } }
}

/** fetch к движку → понятная ошибка. */
export function describeEngineFetchError(e: unknown): string {
  let cur: unknown = e
  for (let i = 0; i < 4 && cur && typeof cur === 'object'; i++) {
    const code = (cur as { code?: unknown }).code
    if (code === 'ECONNREFUSED' || code === 'ECONNRESET' || code === 'UND_ERR_SOCKET' || code === 'EPIPE') {
      return 'Движок недоступен: соединение разорвано. Возможно, он аварийно завершился — посмотрите журнал движка.'
    }
    cur = (cur as { cause?: unknown }).cause
  }
  if (e instanceof TypeError && e.message === 'fetch failed') {
    return 'Движок недоступен. Возможно, он аварийно завершился — посмотрите журнал движка.'
  }
  return e instanceof Error ? e.message : String(e)
}

async function runStream(
  convId: string,
  target: ChatMessage,
  history: ChatMessage[],
  eng: ActiveEngine,
  p: PredictionConfig,
  slot: Running,
  continuing: boolean
): Promise<void> {
  const { controller } = slot
  const version = slot.version!
  const base = { conversationId: convId, messageId: target.id }
  const patches: HistoryPatch[] = []

  // Пакетная отправка дельт (~30 раз в секунду).
  let pendingContent = ''
  let pendingReasoning = ''
  let flushTimer: NodeJS.Timeout | null = null
  const flush = (): void => {
    if (flushTimer) clearTimeout(flushTimer)
    flushTimer = null
    if (!pendingContent && !pendingReasoning) return
    const d: ChatDelta = { ...base }
    if (pendingContent) d.content = pendingContent
    if (pendingReasoning) d.reasoning = pendingReasoning
    pendingContent = ''
    pendingReasoning = ''
    emit('chat:delta', d)
  }
  const push = (content: string, reasoning: string): void => {
    if (content) {
      version.content += content
      pendingContent += content
    }
    if (reasoning) {
      version.reasoning = (version.reasoning ?? '') + reasoning
      pendingReasoning += reasoning
    }
    if (!flushTimer && (pendingContent || pendingReasoning)) flushTimer = setTimeout(flush, 33)
  }

  const started = Date.now()
  let firstTokenAt = 0
  let finish: string | null | undefined
  let sawDone = false
  let usage: StreamChunk['usage']
  let timings: StreamChunk['timings']
  let streamedChunks = 0
  let aborted = false

  try {
    const ctx = eng.contextLength
    const reserve = p.maxTokens.enabled ? p.maxTokens.value : Math.min(2048, Math.floor(ctx / 4))
    const budget = Math.max(256, ctx - reserve)
    const system = p.systemPrompt.trim() ? p.systemPrompt : ''
    const systemTokens = system ? (await countTokens(eng, system)) + 8 : 0
    const { messages, counts } = await toOpenAi(history, eng, Math.floor(budget * 0.6), patches)
    const { keep } = fitHistory(counts, systemTokens, budget, p.contextOverflow)
    const finalMessages: OpenAiMessage[] = []
    if (system) finalMessages.push({ role: 'system', content: system })
    for (const i of keep) finalMessages.push(messages[i]!)

    const body: Record<string, unknown> = {
      model: eng.modelId,
      messages: finalMessages,
      stream: true,
      stream_options: { include_usage: true },
      ...buildSamplingParams(p, eng.engine)
    }
    if (continuing) Object.assign(body, continuationParams(body, eng.engine, finalMessages))
    let res: Response
    try {
      res = await fetch(`${eng.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders(eng.apiKey) },
        body: JSON.stringify(body),
        signal: controller.signal
      })
    } catch (e) {
      if (controller.signal.aborted) throw e
      throw new Error(describeEngineFetchError(e), { cause: e })
    }
    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => '')
      throw new Error(engineError(text) || `Движок ответил ошибкой ${res.status}`)
    }

    // Если движок сам не отделил рассуждения — режем по тегам.
    const splitter = p.reasoning.parsing
      ? new ThinkSplitter(p.reasoning.startString, p.reasoning.endString, { afterContent: continuing })
      : null
    const sse = new SseParser()
    const decoder = new TextDecoder()
    const reader = res.body.getReader()
    for (;;) {
      let chunkRead: Awaited<ReturnType<typeof reader.read>>
      try {
        chunkRead = await reader.read()
      } catch (e) {
        if (controller.signal.aborted) throw e
        throw new Error(describeEngineFetchError(e), { cause: e })
      }
      const { value, done } = chunkRead
      if (done) break
      for (const data of sse.push(decoder.decode(value, { stream: true }))) {
        if (data === '[DONE]') {
          sawDone = true
          continue
        }
        let chunk: StreamChunk
        try {
          chunk = JSON.parse(data) as StreamChunk
        } catch {
          continue
        }
        if (chunk.error) throw new Error(typeof chunk.error === 'string' ? chunk.error : chunk.error.message)
        if (chunk.usage) usage = chunk.usage
        if (chunk.timings) timings = chunk.timings
        const choice = chunk.choices?.[0]
        if (!choice) continue
        if (choice.finish_reason) finish = choice.finish_reason
        const reasoning = choice.delta?.reasoning_content ?? choice.delta?.reasoning ?? ''
        const content = choice.delta?.content ?? ''
        if (!reasoning && !content) continue
        if (!firstTokenAt) firstTokenAt = Date.now()
        streamedChunks++
        if (splitter && content) {
          const s = splitter.feed(content)
          if (s.reclassify) {
            // Шаблон открыл <think> сам: уже показанный «ответ» переносим в рассуждения.
            flush()
            version.reasoning = (version.reasoning ?? '') + version.content + reasoning + s.reasoning
            version.content = ''
            const latest = await getConversation(convId)
            if (latest) emit('chat:updated', latest)
            push(s.content, '')
          } else {
            push(s.content, reasoning + s.reasoning)
          }
        } else {
          push(content, reasoning)
        }
      }
    }
    if (splitter) {
      const s = splitter.flush()
      push(s.content, s.reasoning)
    }
    if (!finish && !sawDone && !controller.signal.aborted) {
      throw new Error('Движок оборвал ответ. Возможно, он аварийно завершился — посмотрите журнал движка.')
    }
  } catch (e) {
    if (controller.signal.aborted) aborted = true
    else version.error = e instanceof Error ? e.message : String(e)
  }

  flush()
  // Пустой блок рассуждений (<think>\n\n</think>) не показываем.
  if (version.reasoning !== undefined && !version.reasoning.trim()) delete version.reasoning

  const end = Date.now()
  const completionTokens = timings?.predicted_n ?? usage?.completion_tokens ?? streamedChunks
  const genSeconds = firstTokenAt ? (end - firstTokenAt) / 1000 : 0
  const stats: GenerationStats = {
    tokensPerSecond: timings?.predicted_per_second ?? (genSeconds > 0 ? completionTokens / genSeconds : 0),
    timeToFirstTokenMs: firstTokenAt ? firstTokenAt - started : 0,
    promptTokens: timings?.prompt_n ?? usage?.prompt_tokens ?? 0,
    completionTokens,
    promptTokensPerSecond: timings?.prompt_per_second,
    stopReason: version.error ? 'failed' : mapStopReason(finish, aborted, p, completionTokens),
    draftTotal: timings?.draft_n,
    draftAccepted: timings?.draft_n_accepted
  }
  version.stats = stats

  // Сохраняем в актуальную копию диалога: пока шёл стрим, его могли переименовать, изменить или удалить.
  const latest = await getConversation(convId)
  let saved: Conversation | null = null
  if (latest) {
    applyResult(latest, target.id, slot.versionIndex, version, patches)
    saved = await saveConversation(latest).catch((e: unknown) => {
      console.error('[chat] не удалось сохранить диалог:', e)
      return latest
    })
  }
  emit('chat:delta', { ...base, done: true, stats, error: version.error })
  if (saved) emit('chat:updated', saved)
}

/** Кладёт итог генерации в свежую копию диалога (по id, а не по ссылкам). */
export function applyResult(
  c: Conversation,
  messageId: string,
  versionIndex: number,
  version: MessageVersion,
  patches: HistoryPatch[] = []
): void {
  const msg = c.messages.find((m) => m.id === messageId)
  // Сообщение удалили во время генерации — не воскрешаем.
  if (msg) putVersion(msg, versionIndex, version)
  for (const p of patches) {
    const m = c.messages.find((x) => x.id === p.messageId)
    if (!m) continue
    if (p.citations) m.citations = p.citations
    else delete m.citations
    for (const a of m.attachments ?? []) {
      const mode = p.injection[a.id]
      if (mode) a.injection = mode
    }
  }
}

function engineError(text: string): string {
  try {
    const j = JSON.parse(text) as { error?: { message?: string } | string; detail?: unknown }
    if (typeof j.error === 'string') return j.error
    if (j.error?.message) return j.error.message
    if (j.detail) return typeof j.detail === 'string' ? j.detail : JSON.stringify(j.detail)
  } catch {
    // не JSON
  }
  return text.slice(0, 500)
}
