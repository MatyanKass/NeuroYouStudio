import type { PredictionConfig } from '@shared/config'
import type {
  ChatDelta,
  ChatMessage,
  Conversation,
  GenerateRequest,
  GenerationStats,
  MessageVersion,
  StopReason
} from '@shared/types'
import { activeEngine, type ActiveEngine } from '../engines/manager'
import { emit } from '../ipc'
import { getSettings } from '../settings'
import { newId } from '../util/id'
import { imageDataUrl } from '../attachments'
import { buildDocumentContext } from '../attachments/documents'
import { fitHistory, type CountedMessage } from './context'
import { buildSamplingParams } from './params'
import { SseParser } from './sse'
import { ThinkSplitter } from './think'
import { countTokens } from './tokens'
import { getConversation, saveConversation, titleFromText } from './store'

type OpenAiContent = string | Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }>
interface OpenAiMessage {
  role: 'system' | 'user' | 'assistant'
  content: OpenAiContent
}

const IMAGE_TOKENS_ESTIMATE = 768

let running: { controller: AbortController; conversationId: string; messageId: string } | null = null

export const isGenerating = (): boolean => running !== null

export function stopGeneration(): void {
  running?.controller.abort()
}

const activeText = (m: ChatMessage): string => m.versions[m.activeVersion]?.content ?? ''

/** Сообщения истории → формат OpenAI (с картинками и документами). */
async function toOpenAi(
  history: ChatMessage[],
  eng: ActiveEngine,
  docBudgetTokens: number
): Promise<{ messages: OpenAiMessage[]; counts: CountedMessage[] }> {
  const maxDim = getSettings().imageMaxDimension
  const messages: OpenAiMessage[] = []
  const counts: CountedMessage[] = []
  for (let i = 0; i < history.length; i++) {
    const m = history[i]!
    if (m.role === 'system') continue
    let text = activeText(m)
    const atts = m.attachments ?? []
    const docs = atts.filter((a) => a.kind === 'document')
    const images = atts.filter((a) => a.kind === 'image')
    if (docs.length) {
      // Документы последнего сообщения получают полный бюджет, старые — только то, что уже было подставлено.
      const isLast = i === history.length - 1
      const ctx = await buildDocumentContext(docs, text, isLast ? docBudgetTokens : Math.floor(docBudgetTokens / 4), eng)
      for (const a of docs) a.injection = ctx.mode
      if (isLast && ctx.citations.length) m.citations = ctx.citations
      text = `${ctx.text}\n\n${text}`
    }
    let tokens = (await countTokens(eng, text)) + 8
    let content: OpenAiContent = text
    if (images.length && m.role === 'user') {
      if (!eng.vision) {
        throw new Error('Загруженная модель не поддерживает изображения. Выберите vision-модель (с файлом mmproj).')
      }
      const parts: Exclude<OpenAiContent, string> = []
      for (const img of images) parts.push({ type: 'image_url', image_url: { url: await imageDataUrl(img, maxDim) } })
      parts.push({ type: 'text', text })
      content = parts
      tokens += images.length * IMAGE_TOKENS_ESTIMATE
    }
    messages.push({ role: m.role, content })
    counts.push({ role: m.role, tokens })
  }
  return { messages, counts }
}

function mapStopReason(
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
  const conv = await getConversation(req.conversationId)
  if (!conv) throw new Error('Диалог не найден')
  const p = req.prediction

  // Целевое сообщение ассистента и история до него.
  let target: ChatMessage
  let history: ChatMessage[]
  if (req.regenerateMessageId) {
    const idx = conv.messages.findIndex((m) => m.id === req.regenerateMessageId)
    if (idx < 0) throw new Error('Сообщение не найдено')
    target = conv.messages[idx]!
    history = conv.messages.slice(0, idx)
    target.versions.push({ content: '', createdAt: Date.now(), modelId: eng.modelId })
    target.activeVersion = target.versions.length - 1
    conv.messages = conv.messages.slice(0, idx + 1)
  } else if (req.continueMessageId) {
    const idx = conv.messages.findIndex((m) => m.id === req.continueMessageId)
    if (idx < 0) throw new Error('Сообщение не найдено')
    target = conv.messages[idx]!
    history = conv.messages.slice(0, idx + 1)
  } else {
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
  await saveConversation(conv)
  emit('chat:updated', conv)

  const controller = new AbortController()
  running = { controller, conversationId: conv.id, messageId: target.id }
  // Остальное — асинхронно, результат приходит событиями chat:delta / chat:updated.
  void runStream(conv, target, history, eng, p, controller).finally(() => {
    running = null
  })
}

async function runStream(
  conv: Conversation,
  target: ChatMessage,
  history: ChatMessage[],
  eng: ActiveEngine,
  p: PredictionConfig,
  controller: AbortController
): Promise<void> {
  const version: MessageVersion = target.versions[target.activeVersion]!
  const base = { conversationId: conv.id, messageId: target.id }

  // Пакетная отправка дельт (~30 раз в секунду).
  let pendingContent = ''
  let pendingReasoning = ''
  let flushTimer: NodeJS.Timeout | null = null
  const flush = (): void => {
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
    if (!flushTimer) flushTimer = setTimeout(flush, 33)
  }

  const started = Date.now()
  let firstTokenAt = 0
  let finish: string | null | undefined
  let usage: StreamChunk['usage']
  let timings: StreamChunk['timings']
  let streamedChunks = 0
  let aborted = false

  try {
    const ctx = eng.contextLength
    const reserve = p.maxTokens.enabled ? p.maxTokens.value : Math.min(2048, Math.floor(ctx / 4))
    const budget = Math.max(256, ctx - reserve)
    const systemTokens = p.systemPrompt ? (await countTokens(eng, p.systemPrompt)) + 8 : 0
    const { messages, counts } = await toOpenAi(history, eng, Math.floor(budget * 0.6))
    const { keep } = fitHistory(counts, systemTokens, budget, p.contextOverflow)
    const finalMessages: OpenAiMessage[] = []
    if (p.systemPrompt.trim()) finalMessages.push({ role: 'system', content: p.systemPrompt })
    for (const i of keep) finalMessages.push(messages[i]!)

    const body = {
      model: eng.modelId,
      messages: finalMessages,
      stream: true,
      stream_options: { include_usage: true },
      ...buildSamplingParams(p, eng.engine)
    }
    const res = await fetch(`${eng.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal
    })
    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => '')
      throw new Error(engineError(text) || `Движок ответил ошибкой ${res.status}`)
    }

    // Если движок сам не отделил рассуждения — режем по тегам.
    const splitter = p.reasoning.parsing ? new ThinkSplitter(p.reasoning.startString, p.reasoning.endString) : null
    const sse = new SseParser()
    const decoder = new TextDecoder()
    const reader = res.body.getReader()
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      for (const data of sse.push(decoder.decode(value, { stream: true }))) {
        if (data === '[DONE]') continue
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
          push(s.content, reasoning + s.reasoning)
        } else {
          push(content, reasoning)
        }
      }
    }
    if (splitter) {
      const s = splitter.flush()
      push(s.content, s.reasoning)
    }
  } catch (e) {
    if (controller.signal.aborted) aborted = true
    else version.error = e instanceof Error ? e.message : String(e)
  }

  if (flushTimer) clearTimeout(flushTimer)
  flush()

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
  await saveConversation(conv)
  emit('chat:delta', { ...base, done: true, stats, error: version.error })
  emit('chat:updated', conv)
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
