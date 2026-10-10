// Цикл агента: стриминг ответа модели с вызовами инструментов, политика → подтверждение →
// выполнение, снимки шагов в интерфейс, и продолжение диалога результатами инструментов.
import type { PredictionConfig } from '@shared/config'
import type {
  AgentTurn,
  ChatDelta,
  ChatMessage,
  Conversation,
  GenerationStats,
  MessageVersion,
  ToolCallRecord
} from '@shared/types'
import type { ActiveEngine } from '../engines/manager'
import { authHeaders } from '../engines/auth'
import { emit } from '../ipc'
import { getSettings } from '../settings'
import { newId } from '../util/id'
import { SseParser } from '../chat/sse'
import { countTokens } from '../chat/tokens'
import { getConversation, saveConversation } from '../chat/store'
import { AGENT_TOOLS, executeTool, isReadOnlyTool, truncate, type ToolContext } from './tools'
import { evaluateAction } from './policy'
import { askGuard, warmGuard } from './guard'
import { parseTextToolCalls } from './parse-text-tools'

// ---------- сообщения OpenAI с инструментами ----------

interface ToolCallWire {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}
type TextContent = string | Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }>
type Msg =
  | { role: 'system' | 'user'; content: TextContent }
  | { role: 'assistant'; content: string; tool_calls?: ToolCallWire[] }
  | { role: 'tool'; tool_call_id: string; content: string }

const activeText = (m: ChatMessage): string => m.versions[m.activeVersion]?.content ?? ''

// ---------- подтверждения ----------

interface Pending {
  resolve: (d: 'allow' | 'deny' | 'allowAll') => void
}
const pendingApprovals = new Map<string, Map<string, Pending>>()
/** Активные запуски агента по диалогам — чтобы по запросу отдать свежий снимок шагов. */
const activeRuns = new Map<string, { snapshot: () => void }>()

/** Решение пользователя по ожидающему действию (IPC agent:approve). */
export function resolveApproval(conversationId: string, toolCallId: string, decision: 'allow' | 'deny' | 'allowAll'): void {
  pendingApprovals.get(conversationId)?.get(toolCallId)?.resolve(decision)
  // Всегда отдаём свежий снимок шагов — даже если вызов не найден/уже разрешён, чтобы кнопки в UI не зависали.
  activeRuns.get(conversationId)?.snapshot()
}

/** Пометить в диалоге «разрешить всё в этом чате»: сохранить и разослать обновление. */
async function persistAllowAll(convId: string): Promise<void> {
  const c = await getConversation(convId)
  if (!c?.agent || c.agent.allowAll) return
  c.agent = { ...c.agent, allowAll: true }
  const saved = await saveConversation(c)
  if (saved) emit('chat:updated', saved)
}

function awaitApproval(convId: string, toolCallId: string, signal: AbortSignal): Promise<'allow' | 'deny' | 'allowAll'> {
  return new Promise((resolve) => {
    const map = pendingApprovals.get(convId) ?? new Map<string, Pending>()
    pendingApprovals.set(convId, map)
    const done = (d: 'allow' | 'deny' | 'allowAll'): void => {
      map.delete(toolCallId)
      if (!map.size) pendingApprovals.delete(convId)
      signal.removeEventListener('abort', onAbort)
      resolve(d)
    }
    const onAbort = (): void => done('deny')
    if (signal.aborted) return done('deny')
    signal.addEventListener('abort', onAbort, { once: true })
    map.set(toolCallId, { resolve: done })
  })
}

// ---------- системный промпт ----------

function systemPrompt(cwd: string, shells: string, userSystem: string): string {
  const date = new Date().toISOString().slice(0, 10)
  const base = `You are an autonomous coding agent running inside NeuroYouStudio on Windows. Today is ${date}.
Working directory (cwd): ${cwd}
Relative paths and commands resolve against the cwd. Available shells: ${shells}.

You have tools to read/list/search files, write and edit files, and run terminal commands. Rules:
- Read a file before editing it. Prefer edit_file for small changes; use write_file for new files or full rewrites.
- After writing code, verify it by running builds, tests or the program itself via run_command.
- Never invent tool output — only state what tools actually returned.
- To use a tool, make a real tool call. Do NOT print the tool call as JSON text in your reply — a printed call does nothing.
- Some actions ask the user for confirmation or are blocked; if an action is denied, adapt instead of retrying blindly.
- Keep going until the task is done, then briefly summarise (in the user's language) what you changed and how you verified it.
Отвечай пользователю по-русски.`
  return userSystem.trim() ? `${base}\n\n${userSystem.trim()}` : base
}

function toolPreview(name: string, args: Record<string, unknown>): string | undefined {
  if (name === 'write_file') {
    const c = typeof args.content === 'string' ? args.content : ''
    const lines = c.split('\n')
    return lines.length > 20 ? [...lines.slice(0, 10), '…', ...lines.slice(-10)].join('\n') : c
  }
  if (name === 'edit_file') {
    return `- ${truncate(String(args.old_string ?? ''), 600)}\n+ ${truncate(String(args.new_string ?? ''), 600)}`
  }
  return undefined
}

// ---------- построение истории ----------

async function buildBaseMessages(history: ChatMessage[], eng: ActiveEngine, budget: number): Promise<Msg[]> {
  const groups: { msgs: Msg[]; tokens: number }[] = []
  let cur: { msgs: Msg[]; tokens: number } | null = null
  for (const m of history) {
    if (m.role === 'system') continue
    const text = activeText(m)
    const built: Msg[] = []
    if (m.role === 'user') {
      built.push({ role: 'user', content: text })
    } else {
      const turns = m.versions[m.activeVersion]?.turns
      if (turns?.length) {
        for (const t of turns) {
          const wire: ToolCallWire[] = t.toolCalls.map((c) => ({
            id: c.id,
            type: 'function',
            function: { name: String(c.name), arguments: JSON.stringify(c.args ?? {}) }
          }))
          built.push({ role: 'assistant', content: t.content, ...(wire.length ? { tool_calls: wire } : {}) })
          for (const c of t.toolCalls) built.push({ role: 'tool', tool_call_id: c.id, content: c.result ?? c.error ?? '' })
        }
      } else {
        built.push({ role: 'assistant', content: text })
      }
    }
    const tokens = (await countTokens(eng, built.map((b) => (typeof b.content === 'string' ? b.content : '')).join('\n'))) + 8
    if (m.role === 'user' || !cur) {
      cur = { msgs: built, tokens }
      groups.push(cur)
    } else {
      cur.msgs.push(...built)
      cur.tokens += tokens
    }
  }
  // Переполнение контекста: выбрасываем самые старые ходы целиком, последний оставляем.
  let total = groups.reduce((s, g) => s + g.tokens, 0)
  let start = 0
  while (total > budget && start < groups.length - 1) {
    total -= groups[start]!.tokens
    start++
  }
  return groups.slice(start).flatMap((g) => g.msgs)
}

// ---------- стриминг одного шага ----------

interface StepStream {
  content: string
  reasoning: string
  toolCalls: Array<{ id: string; name: string; arguments: string }>
  finish: string | null
  usage?: { prompt_tokens?: number; completion_tokens?: number }
  timings?: { prompt_n?: number; predicted_n?: number }
}

interface StepChunk {
  choices?: Array<{
    delta?: {
      content?: string | null
      reasoning_content?: string | null
      reasoning?: string | null
      tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }>
    }
    finish_reason?: string | null
  }>
  usage?: StepStream['usage']
  timings?: StepStream['timings']
  error?: { message?: string } | string
}

function toolErrorMessage(text: string): string | null {
  if (/tool|function[_ ]call|template|jinja|does not support/i.test(text)) {
    return 'Модель не поддерживает вызов инструментов — выберите модель с поддержкой tools, например Qwen3 или Qwen3-Coder.'
  }
  return null
}

async function streamStep(
  eng: ActiveEngine,
  messages: Msg[],
  p: PredictionConfig,
  signal: AbortSignal,
  onText: (content: string, reasoning: string) => void
): Promise<StepStream> {
  const body: Record<string, unknown> = {
    model: eng.modelId,
    messages,
    stream: true,
    stream_options: { include_usage: true },
    tools: AGENT_TOOLS,
    tool_choice: 'auto',
    parallel_tool_calls: false,
    temperature: p.temperature,
    chat_template_kwargs: { enable_thinking: p.reasoning.enableThinking }
  }
  if (p.maxTokens.enabled) body.max_tokens = p.maxTokens.value

  const res = await fetch(`${eng.baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders(eng.apiKey) },
    body: JSON.stringify(body),
    signal
  })
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => '')
    throw new Error(toolErrorMessage(text) || engineError(text) || `Движок ответил ошибкой ${res.status}`)
  }

  const out: StepStream = { content: '', reasoning: '', toolCalls: [], finish: null }
  const byIndex = new Map<number, { id: string; name: string; arguments: string }>()
  const sse = new SseParser()
  const decoder = new TextDecoder()
  const reader = res.body.getReader()
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    for (const data of sse.push(decoder.decode(value, { stream: true }))) {
      if (data === '[DONE]') continue
      let chunk: StepChunk
      try {
        chunk = JSON.parse(data) as StepChunk
      } catch {
        continue
      }
      if (chunk.error) throw new Error(typeof chunk.error === 'string' ? chunk.error : (chunk.error.message ?? 'ошибка'))
      if (chunk.usage) out.usage = chunk.usage
      if (chunk.timings) out.timings = chunk.timings
      const choice = chunk.choices?.[0]
      if (!choice) continue
      if (choice.finish_reason) out.finish = choice.finish_reason
      const d = choice.delta
      if (!d) continue
      const reasoning = d.reasoning_content ?? d.reasoning ?? ''
      const content = d.content ?? ''
      if (content) out.content += content
      if (reasoning) out.reasoning += reasoning
      if (content || reasoning) onText(content, reasoning)
      for (const tc of d.tool_calls ?? []) {
        const idx = tc.index ?? 0
        const cur = byIndex.get(idx) ?? { id: '', name: '', arguments: '' }
        if (tc.id) cur.id = tc.id
        if (tc.function?.name) cur.name = tc.function.name
        if (tc.function?.arguments) cur.arguments += tc.function.arguments
        byIndex.set(idx, cur)
      }
    }
  }
  out.toolCalls = [...byIndex.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v)
  return out
}

function engineError(text: string): string {
  try {
    const j = JSON.parse(text) as { error?: { message?: string } | string }
    if (typeof j.error === 'string') return j.error
    if (j.error?.message) return j.error.message
  } catch {
    // не JSON
  }
  return text.slice(0, 500)
}

// ---------- параметры запуска ----------

export interface AgentRunContext {
  convId: string
  target: ChatMessage
  history: ChatMessage[]
  eng: ActiveEngine
  prediction: PredictionConfig
  version: MessageVersion
  versionIndex: number
  controller: AbortController
  cwd: string
  allowAll: boolean
}

export async function runAgentStream(rc: AgentRunContext): Promise<void> {
  const { eng, controller, version } = rc
  const settings = getSettings().agent
  const base = { conversationId: rc.convId, messageId: rc.target.id }
  const signal = controller.signal
  const started = Date.now()
  let firstTokenAt = 0
  let promptTokens = 0
  let completionTokens = 0
  let sessionAllowAll = rc.allowAll

  // Охранник поднимается параллельно с первым шагом модели — к первой команде он уже готов.
  if (settings.guardEnabled) warmGuard()

  const turns: AgentTurn[] = []
  version.turns = turns
  const userRequest = activeText([...rc.history].reverse().find((m) => m.role === 'user') ?? rc.target)

  // Пакетная отправка текстовых дельт (как в обычной генерации).
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
  const emitTurns = (): void => {
    flush()
    emit('chat:delta', { ...base, turns: structuredClone(turns) })
  }
  activeRuns.set(rc.convId, { snapshot: emitTurns })

  const contextLen = eng.contextLength
  const reserve = rc.prediction.maxTokens.enabled ? rc.prediction.maxTokens.value : Math.min(2048, Math.floor(contextLen / 4))
  const budget = Math.max(512, contextLen - reserve - 1024)
  const shells = `powershell, cmd (по умолчанию ${settings.defaultShell})`
  const sys = systemPrompt(rc.cwd, shells, rc.prediction.systemPrompt)

  const baseMessages = await buildBaseMessages(rc.history, eng, Math.floor(budget * 0.7))
  const messages: Msg[] = [{ role: 'system', content: sys }, ...baseMessages]

  try {
    let hitLimit = false
    for (let step = 0; step < settings.maxSteps; step++) {
      if (signal.aborted) break
      const turn: AgentTurn = { content: '', toolCalls: [] }
      turns.push(turn)
      version.content = ''
      emitTurns()

      const result = await streamStep(eng, messages, rc.prediction, signal, (content, reasoning) => {
        if (!firstTokenAt) firstTokenAt = Date.now()
        if (content) {
          turn.content += content
          version.content = turn.content
          pendingContent += content
        }
        if (reasoning) {
          turn.reasoning = (turn.reasoning ?? '') + reasoning
          version.reasoning = turn.reasoning
          pendingReasoning += reasoning
        }
        if (!flushTimer && (pendingContent || pendingReasoning)) flushTimer = setTimeout(flush, 33)
      })
      flush()
      promptTokens += result.timings?.prompt_n ?? result.usage?.prompt_tokens ?? 0
      completionTokens += result.timings?.predicted_n ?? result.usage?.completion_tokens ?? 0

      // Запасной случай: модель напечатала вызов инструмента текстом (JSON), а не отдала tool_calls.
      if (!result.toolCalls.length && !signal.aborted) {
        const parsed = parseTextToolCalls(result.content)
        if (parsed.calls.length) {
          result.toolCalls = parsed.calls.map((c) => ({ id: newId('tc_'), name: c.name, arguments: c.arguments }))
          turn.content = parsed.cleaned
          version.content = parsed.cleaned
          emitTurns()
        }
      }

      if (!result.toolCalls.length || signal.aborted) break

      // Записываем вызовы инструментов этого шага.
      const records: ToolCallRecord[] = result.toolCalls.map((tc) => ({
        id: tc.id || newId('tc_'),
        name: tc.name,
        args: parseArgs(tc.arguments),
        status: 'pending'
      }))
      turn.toolCalls = records
      emitTurns()

      const assistantMsg: Msg = {
        role: 'assistant',
        content: turn.content,
        tool_calls: records.map((r) => ({
          id: r.id,
          type: 'function',
          function: { name: String(r.name), arguments: JSON.stringify(r.args) }
        }))
      }
      messages.push(assistantMsg)

      for (const rec of records) {
        if (signal.aborted) {
          rec.status = 'denied'
          rec.result = 'Прервано пользователем.'
          messages.push({ role: 'tool', tool_call_id: rec.id, content: rec.result })
          continue
        }
        await runOneTool(rec, {
          rc,
          settings,
          userRequest,
          sessionAllowAll,
          setAllowAll: () => (sessionAllowAll = true),
          emitTurns,
          signal
        })
        messages.push({ role: 'tool', tool_call_id: rec.id, content: rec.result ?? rec.error ?? '' })
        emitTurns()
      }

      if (step === settings.maxSteps - 1 && result.toolCalls.length) hitLimit = true
    }

    if (hitLimit) {
      const note = '\n\n_(Достигнут предел числа шагов агента. Напишите «продолжи», чтобы агент продолжил.)_'
      const last = turns[turns.length - 1]!
      last.content += note
      version.content = last.content
    }
  } catch (e) {
    if (signal.aborted) {
      // пользовательская остановка — не ошибка
    } else {
      version.error = e instanceof Error ? e.message : String(e)
    }
  }

  flush()
  if (version.reasoning !== undefined && !version.reasoning.trim()) delete version.reasoning
  version.content = turns[turns.length - 1]?.content ?? version.content

  const end = Date.now()
  const genSeconds = firstTokenAt ? (end - firstTokenAt) / 1000 : 0
  const stats: GenerationStats = {
    tokensPerSecond: genSeconds > 0 ? completionTokens / genSeconds : 0,
    timeToFirstTokenMs: firstTokenAt ? firstTokenAt - started : 0,
    promptTokens,
    completionTokens,
    stopReason: version.error ? 'failed' : signal.aborted ? 'userStopped' : 'eosFound'
  }
  version.stats = stats

  const latest = await getConversation(rc.convId)
  let saved: Conversation | null = null
  if (latest) {
    const msg = latest.messages.find((m) => m.id === rc.target.id)
    if (msg) {
      const v = msg.versions[rc.versionIndex]
      if (v && v.createdAt === version.createdAt) msg.versions[rc.versionIndex] = version
      else if (!v && rc.versionIndex === msg.versions.length) {
        msg.versions.push(version)
        msg.activeVersion = rc.versionIndex
      }
    }
    saved = await saveConversation(latest).catch(() => latest)
  }
  pendingApprovals.delete(rc.convId)
  activeRuns.delete(rc.convId)
  emit('chat:delta', { ...base, done: true, stats, error: version.error, turns: structuredClone(turns) })
  if (saved) emit('chat:updated', saved)
}

interface RunToolDeps {
  rc: AgentRunContext
  settings: ReturnType<typeof getSettings>['agent']
  userRequest: string
  sessionAllowAll: boolean
  setAllowAll: () => void
  emitTurns: () => void
  signal: AbortSignal
}

async function runOneTool(rec: ToolCallRecord, deps: RunToolDeps): Promise<void> {
  const { rc, settings } = deps
  const toolCtx: ToolContext = {
    cwd: rc.cwd,
    defaultShell: settings.defaultShell,
    commandTimeoutSec: settings.commandTimeoutSec,
    maxOutputChars: settings.maxOutputChars,
    signal: deps.signal
  }

  if (isReadOnlyTool(rec.name)) {
    rec.status = 'running'
    rec.approvedBy = 'auto'
    deps.emitTurns()
    await execAndStore(rec, toolCtx)
    return
  }

  // Политика: жёсткие правила + (опц.) охранник.
  rec.status = 'checking'
  deps.emitTurns()
  const verdict = await evaluateAction({
    tool: rec.name,
    args: rec.args,
    cwd: rc.cwd,
    userRequest: deps.userRequest,
    preview: toolPreview(rec.name, rec.args),
    guardEnabled: settings.guardEnabled,
    guard: askGuard
  })
  rec.guard = verdict

  // Хард-правило block всегда спрашивает, даже в auto/allowAll — защита от катастрофы.
  // Экспертный режим (allowDangerous) снимает и эту страховку: пользователь берёт риск на себя.
  const forceAsk = verdict.level === 'block' && verdict.by === 'rules' && !settings.allowDangerous
  let needApproval: boolean
  if (forceAsk) needApproval = true
  else if (deps.sessionAllowAll) needApproval = false
  else if (settings.approval === 'auto') needApproval = false
  else if (settings.approval === 'askAll') needApproval = true
  else needApproval = verdict.level !== 'safe' // askDangerous

  if (needApproval) {
    rec.status = 'awaitingApproval'
    deps.emitTurns()
    const decision = await awaitApproval(rc.convId, rec.id, deps.signal)
    if (decision === 'allowAll') {
      deps.setAllowAll()
      await persistAllowAll(rc.convId)
    }
    if (decision === 'deny') {
      rec.status = 'denied'
      rec.result = 'Пользователь отклонил выполнение этого действия.'
      deps.emitTurns()
      return
    }
    rec.approvedBy = decision === 'allowAll' ? 'session' : 'user'
  } else {
    rec.approvedBy = deps.sessionAllowAll ? 'session' : 'auto'
  }

  rec.status = 'running'
  deps.emitTurns()
  await execAndStore(rec, toolCtx)
}

async function execAndStore(rec: ToolCallRecord, ctx: ToolContext): Promise<void> {
  const t0 = Date.now()
  const res = await executeTool(rec.name, rec.args, ctx)
  rec.durationMs = Date.now() - t0
  rec.result = res.content
  if (res.diff) rec.diff = truncate(res.diff, 4000)
  if (typeof res.exitCode === 'number') rec.exitCode = res.exitCode
  if (res.isError) {
    rec.status = 'error'
    rec.error = res.content
  } else {
    rec.status = 'done'
  }
}

function parseArgs(raw: string): Record<string, unknown> {
  if (!raw.trim()) return {}
  try {
    const v = JSON.parse(raw) as unknown
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}
