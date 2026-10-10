// Цикл агента против поддельного OpenAI-совместимого сервера, отдающего вызовы инструментов.
import { createServer, type Server, type ServerResponse } from 'node:http'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_PREDICTION_CONFIG } from '@shared/config'
import type { AgentTurn, ChatDelta, ChatMessage, Conversation } from '@shared/types'

const h = vi.hoisted(() => ({ dir: '', events: [] as Array<{ channel: string; payload: unknown }> }))

vi.mock('electron', () => ({
  app: { getPath: () => h.dir, getVersion: () => '0.0.0', isPackaged: false },
  ipcMain: { handle: () => undefined },
  BrowserWindow: {
    getAllWindows: () => [
      {
        isDestroyed: () => false,
        webContents: { send: (channel: string, payload: unknown) => h.events.push({ channel, payload: structuredClone(payload) }) }
      }
    ]
  },
  safeStorage: { isEncryptionAvailable: () => false }
}))
// Охранник в этом тесте не нужен — заглушка, чтобы не поднимать llama-server.
vi.mock('../../src/main/agent/guard', () => ({ askGuard: async () => null }))

const { runAgentStream, resolveApproval } = await import('../../src/main/agent/loop')
const { createConversation, getConversation, saveConversation } = await import('../../src/main/chat/store')
const { loadSettings, updateSettings } = await import('../../src/main/settings')

// --- поддельный сервер ---
interface Step {
  text?: string
  tool?: { id: string; name: string; args: Record<string, unknown> }
}
let steps: Step[] = []
let reqIndex = 0
let server: Server
let baseUrl = ''
const sse = (res: ServerResponse, obj: unknown): boolean => res.write(`data: ${JSON.stringify(obj)}\n\n`)

function emitStep(res: ServerResponse, step: Step): void {
  if (step.tool) {
    const argStr = JSON.stringify(step.tool.args)
    // Дробим имя и аргументы на чанки — проверяем накопление delta.tool_calls.
    sse(res, { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: step.tool.id, function: { name: step.tool.name, arguments: argStr.slice(0, 3) } }] } }] })
    sse(res, { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: argStr.slice(3, 10) } }] } }] })
    sse(res, { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: argStr.slice(10) } }] } }] })
    sse(res, { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], timings: { prompt_n: 5, predicted_n: 7 } })
  } else {
    sse(res, { choices: [{ index: 0, delta: { content: step.text ?? '' } }] })
    sse(res, { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], timings: { prompt_n: 5, predicted_n: 3 } })
  }
  res.write('data: [DONE]\n\n')
}

beforeAll(async () => {
  h.dir = mkdtempSync(join(tmpdir(), 'nys-agentloop-'))
  server = createServer((req, res) => {
    let raw = ''
    req.on('data', (c: Buffer) => (raw += c.toString()))
    req.on('end', () => {
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {}
      if (req.url === '/tokenize') {
        res.end(JSON.stringify({ tokens: String(body.content ?? '').split(/\s+/).filter(Boolean) }))
        return
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      const step = steps[Math.min(reqIndex, steps.length - 1)] ?? { text: 'конец' }
      reqIndex++
      emitStep(res, step)
      res.end()
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  await loadSettings()
})

afterAll(() => {
  server.close()
  rmSync(h.dir, { recursive: true, force: true })
})

beforeEach(() => {
  reqIndex = 0
  steps = []
  h.events.length = 0
})

const eng = (): Parameters<typeof runAgentStream>[0]['eng'] => ({
  engine: 'llamacpp',
  baseUrl,
  modelId: 'test',
  contextLength: 4096,
  vision: false,
  apiKey: undefined
})

async function makeConv(cwd: string, allowAll = false): Promise<{ conv: Conversation; target: ChatMessage }> {
  const c = await createConversation()
  const user: ChatMessage = { id: 'u1', role: 'user', versions: [{ content: 'сделай дело', createdAt: 1 }], activeVersion: 0 }
  const target: ChatMessage = { id: 'a1', role: 'assistant', versions: [{ content: '', createdAt: 2 }], activeVersion: 0 }
  c.messages = [user, target]
  c.agent = { enabled: true, cwd, allowAll }
  await saveConversation(c)
  return { conv: c, target }
}

function run(conv: Conversation, target: ChatMessage, cwd: string, controller = new AbortController()): Promise<void> {
  return runAgentStream({
    convId: conv.id,
    target,
    history: [conv.messages[0]!],
    eng: eng(),
    prediction: DEFAULT_PREDICTION_CONFIG,
    version: target.versions[0]!,
    versionIndex: 0,
    controller,
    cwd,
    allowAll: conv.agent?.allowAll === true
  })
}

const lastTurns = (): AgentTurn[] | undefined =>
  (h.events.filter((e) => e.channel === 'chat:delta' && (e.payload as ChatDelta).turns).at(-1)?.payload as ChatDelta | undefined)?.turns

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
async function waitFor(pred: () => boolean, ms = 5000): Promise<void> {
  const until = Date.now() + ms
  while (!pred()) {
    if (Date.now() > until) throw new Error('таймаут ожидания')
    await sleep(10)
  }
}

describe('цикл агента', () => {
  it('накапливает вызов инструмента по чанкам, выполняет его (auto) и завершается текстом', async () => {
    await updateSettings({ agent: { approval: 'askDangerous', guardEnabled: false } })
    const cwd = mkdtempSync(join(tmpdir(), 'nys-cwd-'))
    steps = [{ tool: { id: 'call_w', name: 'write_file', args: { path: 'out.txt', content: 'привет' } } }, { text: 'готово' }]
    const { conv, target } = await makeConv(cwd)
    await run(conv, target, cwd)
    expect(existsSync(join(cwd, 'out.txt'))).toBe(true)
    const saved = await getConversation(conv.id)
    const v = saved!.messages[1]!.versions[0]!
    expect(v.content).toBe('готово')
    expect(v.turns).toHaveLength(2)
    const call = v.turns![0]!.toolCalls[0]!
    expect(call.name).toBe('write_file')
    expect(call.args).toEqual({ path: 'out.txt', content: 'привет' })
    expect(call.status).toBe('done')
    expect(call.approvedBy).toBe('auto')
    expect(call.diff).toContain('+привет')
    expect(v.stats?.completionTokens).toBeGreaterThan(0)
    rmSync(cwd, { recursive: true, force: true })
  }, 20_000)

  it('ждёт подтверждения (askAll) и выполняет при allow', async () => {
    await updateSettings({ agent: { approval: 'askAll', guardEnabled: false } })
    const cwd = mkdtempSync(join(tmpdir(), 'nys-cwd-'))
    steps = [{ tool: { id: 'call_a', name: 'write_file', args: { path: 'a.txt', content: 'x' } } }, { text: 'ок' }]
    const { conv, target } = await makeConv(cwd)
    const p = run(conv, target, cwd)
    await waitFor(() => lastTurns()?.[0]?.toolCalls[0]?.status === 'awaitingApproval')
    resolveApproval(conv.id, 'call_a', 'allow')
    await p
    expect(existsSync(join(cwd, 'a.txt'))).toBe(true)
    expect(lastTurns()![0]!.toolCalls[0]!.approvedBy).toBe('user')
    rmSync(cwd, { recursive: true, force: true })
  }, 20_000)

  it('deny: действие не выполняется, модель получает отказ', async () => {
    await updateSettings({ agent: { approval: 'askAll', guardEnabled: false } })
    const cwd = mkdtempSync(join(tmpdir(), 'nys-cwd-'))
    steps = [{ tool: { id: 'call_d', name: 'write_file', args: { path: 'no.txt', content: 'x' } } }, { text: 'понял, не стал' }]
    const { conv, target } = await makeConv(cwd)
    const p = run(conv, target, cwd)
    await waitFor(() => lastTurns()?.[0]?.toolCalls[0]?.status === 'awaitingApproval')
    resolveApproval(conv.id, 'call_d', 'deny')
    await p
    expect(existsSync(join(cwd, 'no.txt'))).toBe(false)
    const call = lastTurns()![0]!.toolCalls[0]!
    expect(call.status).toBe('denied')
    expect(call.result).toContain('отклонил')
    rmSync(cwd, { recursive: true, force: true })
  }, 20_000)

  it('allowAll: сохраняет agent.allowAll и больше не спрашивает', async () => {
    await updateSettings({ agent: { approval: 'askAll', guardEnabled: false } })
    const cwd = mkdtempSync(join(tmpdir(), 'nys-cwd-'))
    steps = [
      { tool: { id: 'call_1', name: 'write_file', args: { path: 'one.txt', content: '1' } } },
      { tool: { id: 'call_2', name: 'write_file', args: { path: 'two.txt', content: '2' } } },
      { text: 'оба готовы' }
    ]
    const { conv, target } = await makeConv(cwd)
    const p = run(conv, target, cwd)
    await waitFor(() => lastTurns()?.[0]?.toolCalls[0]?.status === 'awaitingApproval')
    resolveApproval(conv.id, 'call_1', 'allowAll')
    await p
    expect(existsSync(join(cwd, 'one.txt'))).toBe(true)
    expect(existsSync(join(cwd, 'two.txt'))).toBe(true)
    const saved = await getConversation(conv.id)
    expect(saved!.agent?.allowAll).toBe(true)
    expect(h.events.some((e) => e.channel === 'chat:updated' && (e.payload as Conversation).agent?.allowAll === true)).toBe(true)
    // Второй вызов выполнен без запроса подтверждения.
    expect(saved!.messages[1]!.versions[0]!.turns![1]!.toolCalls[0]!.approvedBy).toBe('session')
    rmSync(cwd, { recursive: true, force: true })
  }, 20_000)

  it('stop во время ожидания подтверждения прерывает запуск', async () => {
    await updateSettings({ agent: { approval: 'askAll', guardEnabled: false } })
    const cwd = mkdtempSync(join(tmpdir(), 'nys-cwd-'))
    steps = [{ tool: { id: 'call_s', name: 'write_file', args: { path: 's.txt', content: 'x' } } }, { text: 'не должно дойти' }]
    const { conv, target } = await makeConv(cwd)
    const controller = new AbortController()
    const p = run(conv, target, cwd, controller)
    await waitFor(() => lastTurns()?.[0]?.toolCalls[0]?.status === 'awaitingApproval')
    controller.abort()
    await p
    expect(existsSync(join(cwd, 's.txt'))).toBe(false)
    const v = (await getConversation(conv.id))!.messages[1]!.versions[0]!
    expect(v.turns![0]!.toolCalls[0]!.status).toBe('denied')
    expect(v.stats?.stopReason).toBe('userStopped')
    rmSync(cwd, { recursive: true, force: true })
  }, 20_000)

  it('maxSteps: прекращает после предела и помечает это', async () => {
    await updateSettings({ agent: { approval: 'auto', guardEnabled: false, maxSteps: 2 } })
    const cwd = mkdtempSync(join(tmpdir(), 'nys-cwd-'))
    // Сервер всегда возвращает вызов инструмента — цикл упрётся в предел.
    steps = [{ tool: { id: 'c', name: 'write_file', args: { path: 'loop.txt', content: 'x' } } }]
    const { conv, target } = await makeConv(cwd)
    await run(conv, target, cwd)
    const v = (await getConversation(conv.id))!.messages[1]!.versions[0]!
    expect(v.turns).toHaveLength(2)
    expect(v.content).toContain('предел')
    rmSync(cwd, { recursive: true, force: true })
  }, 20_000)

  it('опасная по жёстким правилам команда в auto обычно спрашивает подтверждение', async () => {
    await updateSettings({ agent: { approval: 'auto', guardEnabled: false, allowDangerous: false } })
    const cwd = mkdtempSync(join(tmpdir(), 'nys-cwd-'))
    steps = [{ tool: { id: 'rm', name: 'run_command', args: { command: 'Remove-Item -Recurse -Force C:\\Windows' } } }, { text: 'ок' }]
    const { conv, target } = await makeConv(cwd)
    const p = run(conv, target, cwd)
    await waitFor(() => lastTurns()?.[0]?.toolCalls[0]?.status === 'awaitingApproval')
    resolveApproval(conv.id, 'rm', 'deny')
    await p
    expect(lastTurns()![0]!.toolCalls[0]!.status).toBe('denied')
    rmSync(cwd, { recursive: true, force: true })
  }, 20_000)

  it('экспертный режим (allowDangerous) не спрашивает даже про опасную команду', async () => {
    await updateSettings({ agent: { approval: 'auto', guardEnabled: false, allowDangerous: true } })
    const cwd = mkdtempSync(join(tmpdir(), 'nys-cwd-'))
    // reg delete — опасно по жёстким правилам; ключ заведомо не существует, команда безвредна.
    steps = [
      { tool: { id: 'd', name: 'run_command', args: { command: 'reg delete HKCU\\Software\\__nys_test_nonexistent__ /f', shell: 'cmd' } } },
      { text: 'готово' }
    ]
    const { conv, target } = await makeConv(cwd)
    await run(conv, target, cwd)
    const v = (await getConversation(conv.id))!.messages[1]!.versions[0]!
    const call = v.turns![0]!.toolCalls[0]!
    expect(call.status).not.toBe('awaitingApproval')
    expect(call.status).not.toBe('denied')
    expect(call.approvedBy).toBe('auto')
    rmSync(cwd, { recursive: true, force: true })
  }, 20_000)

  it('вызов инструмента, напечатанный текстом (без tool_calls), всё равно выполняется', async () => {
    await updateSettings({ agent: { approval: 'askDangerous', guardEnabled: false } })
    const cwd = mkdtempSync(join(tmpdir(), 'nys-cwd-'))
    // Модель печатает вызов как JSON в тексте — настоящего tool_calls нет.
    const printed = ['Создаю файл.', '```json', '{"name":"write_file","arguments":{"path":"plan.md","content":"# План"}}', '```'].join('\n')
    steps = [{ text: printed }, { text: 'Файл создан.' }]
    const { conv, target } = await makeConv(cwd)
    await run(conv, target, cwd)
    expect(existsSync(join(cwd, 'plan.md'))).toBe(true)
    const v = (await getConversation(conv.id))!.messages[1]!.versions[0]!
    expect(v.turns![0]!.toolCalls[0]!.name).toBe('write_file')
    expect(v.turns![0]!.toolCalls[0]!.status).toBe('done')
    // JSON убран из видимого текста шага.
    expect(v.turns![0]!.content).not.toContain('{"name"')
    rmSync(cwd, { recursive: true, force: true })
  }, 20_000)
})
