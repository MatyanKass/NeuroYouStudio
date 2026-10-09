// Генерация целиком против поддельного llama-server: стрим, ключ API, гонки сохранений и удаления.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_PREDICTION_CONFIG } from '@shared/config'
import type { ChatDelta, Conversation } from '@shared/types'

const h = vi.hoisted(() => ({
  dir: '',
  events: [] as Array<{ channel: string; payload: unknown }>,
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  engine: null as null | {
    engine: 'llamacpp' | 'exl3'
    baseUrl: string
    modelId: string
    contextLength: number
    vision: boolean
    apiKey?: string
  }
}))

vi.mock('electron', () => ({
  app: { getPath: () => h.dir, getVersion: () => '0.0.0', isPackaged: false },
  ipcMain: { handle: (ch: string, fn: (...args: unknown[]) => unknown) => h.handlers.set(ch, fn) },
  BrowserWindow: {
    getAllWindows: () => [
      {
        isDestroyed: () => false,
        webContents: {
          // Как настоящий IPC: получатель видит копию, а не живой объект.
          send: (channel: string, payload: unknown) => h.events.push({ channel, payload: structuredClone(payload) })
        }
      }
    ]
  },
  safeStorage: { isEncryptionAvailable: () => false },
  dialog: {},
  nativeImage: {}
}))
vi.mock('../engines/manager', () => ({ activeEngine: () => h.engine }))

const { registerChatIpc } = await import('./index')
const { getConversation } = await import('./store')

type Script = (req: IncomingMessage, body: Record<string, unknown>, res: ServerResponse) => Promise<void> | void
let script: Script = () => undefined
const requests: Array<{ url: string; auth?: string; body: Record<string, unknown> }> = []
let server: Server

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const sse = (res: ServerResponse, obj: unknown): boolean => res.write(`data: ${JSON.stringify(obj)}\n\n`)
const delta = (content: string, extra: Record<string, unknown> = {}): unknown => ({
  choices: [{ delta: { content }, finish_reason: null }],
  ...extra
})
const finishChunk = { choices: [{ delta: {}, finish_reason: 'stop' }], timings: { predicted_n: 3, predicted_per_second: 42, prompt_n: 10 } }

async function invoke<T = unknown>(ch: string, ...args: unknown[]): Promise<T> {
  const fn = h.handlers.get(ch)
  if (!fn) throw new Error(`нет обработчика ${ch}`)
  return (await fn({}, ...args)) as T
}

async function waitFor(pred: () => boolean, ms = 5000): Promise<void> {
  const until = Date.now() + ms
  while (!pred()) {
    if (Date.now() > until) throw new Error('таймаут ожидания')
    await sleep(5)
  }
}

const doneEvents = (): ChatDelta[] =>
  h.events.filter((e) => e.channel === 'chat:delta' && (e.payload as ChatDelta).done).map((e) => e.payload as ChatDelta)

async function newChat(text = 'Привет'): Promise<Conversation> {
  const c = await invoke<Conversation>('chat:create')
  const next: Conversation = {
    ...c,
    messages: [{ id: 'u1', role: 'user', versions: [{ content: text, createdAt: 1 }], activeVersion: 0 }]
  }
  await invoke('chat:save', next)
  return next
}

async function generateAndWait(req: Record<string, unknown>): Promise<ChatDelta> {
  const before = doneEvents().length
  await invoke('chat:generate', { prediction: DEFAULT_PREDICTION_CONFIG, ...req })
  await waitFor(() => doneEvents().length > before)
  return doneEvents()[before]!
}

beforeAll(async () => {
  h.dir = mkdtempSync(join(tmpdir(), 'nys-chat-'))
  server = createServer((req, res) => {
    let raw = ''
    req.on('data', (c: Buffer) => (raw += c.toString()))
    req.on('end', () => {
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {}
      requests.push({ url: req.url ?? '', auth: req.headers.authorization, body })
      if (req.headers.authorization !== 'Bearer k1') {
        res.writeHead(401, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'Invalid API Key' } }))
        return
      }
      if (req.url === '/tokenize') {
        res.end(JSON.stringify({ tokens: String(body.content ?? '').split(/\s+/).filter(Boolean) }))
        return
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      void Promise.resolve(script(req, body, res)).then(() => res.end())
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as { port: number }).port
  h.engine = {
    engine: 'llamacpp',
    baseUrl: `http://127.0.0.1:${port}`,
    modelId: 'test-model',
    contextLength: 4096,
    vision: false,
    apiKey: 'k1'
  }
  registerChatIpc()
})

afterAll(() => {
  server.close()
  rmSync(h.dir, { recursive: true, force: true })
})

beforeEach(() => {
  requests.length = 0
  h.engine!.engine = 'llamacpp'
  script = async (_req, _body, res) => {
    sse(res, delta('Привет'))
    sse(res, delta(', мир'))
    sse(res, finishChunk)
    res.write('data: [DONE]\n\n')
  }
})

describe('генерация', () => {
  it('стримит ответ, шлёт ключ API и сохраняет статистику llama-server', async () => {
    const c = await newChat()
    const done = await generateAndWait({ conversationId: c.id })
    expect(done.error).toBeUndefined()
    const saved = await getConversation(c.id)
    const v = saved!.messages[1]!.versions[0]!
    expect(v.content).toBe('Привет, мир')
    expect(v.stats).toMatchObject({ tokensPerSecond: 42, completionTokens: 3, promptTokens: 10, stopReason: 'eosFound' })
    expect(requests.every((r) => r.auth === 'Bearer k1')).toBe(true)
    expect(requests.some((r) => r.url === '/tokenize')).toBe(true)
    expect(saved!.title).toBe('Привет')
  })

  it('переименование во время стрима не теряется, а ответ не обрезается', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    script = async (_req, _body, res) => {
      sse(res, delta('Раз'))
      await gate
      sse(res, delta(' два'))
      sse(res, finishChunk)
    }
    const c = await newChat()
    const before = doneEvents().length
    await invoke('chat:generate', { conversationId: c.id, prediction: DEFAULT_PREDICTION_CONFIG })
    await waitFor(() => h.events.some((e) => e.channel === 'chat:delta' && (e.payload as ChatDelta).content === 'Раз'))
    // Интерфейс сохраняет свою копию: новое имя и неполный ответ.
    const snapshot = structuredClone((await getConversation(c.id))!)
    snapshot.title = 'Моё имя'
    await invoke('chat:save', snapshot)
    release()
    // Итог сохраняется до события done.
    await waitFor(() => doneEvents().length > before)
    const saved = await getConversation(c.id)
    expect(saved!.title).toBe('Моё имя')
    expect(saved!.messages[1]!.versions[0]!.content).toBe('Раз два')
    // Запоздалое сохранение того же снимка после конца стрима не затирает готовый ответ.
    await invoke('chat:save', snapshot)
    expect((await getConversation(c.id))!.messages[1]!.versions[0]!.content).toBe('Раз два')
  })

  it('снимок интерфейса, сделанный до появления ответа/новой версии, не теряет их', async () => {
    let release!: () => void
    let gate = new Promise<void>((r) => (release = r))
    script = async (_req, _body, res) => {
      sse(res, delta('Ответ'))
      await gate
      sse(res, finishChunk)
    }
    const c = await newChat()
    const stale = structuredClone((await getConversation(c.id))!)
    let before = doneEvents().length
    await invoke('chat:generate', { conversationId: c.id, prediction: DEFAULT_PREDICTION_CONFIG })
    await invoke('chat:save', { ...stale, title: 'Снимок без ответа' })
    release()
    await waitFor(() => doneEvents().length > before)
    let saved = (await getConversation(c.id))!
    expect(saved.title).toBe('Снимок без ответа')
    expect(saved.messages).toHaveLength(2)
    expect(saved.messages[1]!.versions[0]!.content).toBe('Ответ')

    // Перегенерация: снимок с одной версией не съедает новую.
    gate = new Promise<void>((r) => (release = r))
    const staleOne = structuredClone(saved)
    before = doneEvents().length
    await invoke('chat:generate', {
      conversationId: c.id,
      regenerateMessageId: saved.messages[1]!.id,
      prediction: DEFAULT_PREDICTION_CONFIG
    })
    await invoke('chat:save', staleOne)
    release()
    await waitFor(() => doneEvents().length > before)
    saved = (await getConversation(c.id))!
    expect(saved.messages[1]!.versions).toHaveLength(2)
    expect(saved.messages[1]!.activeVersion).toBe(1)
    expect(saved.messages[1]!.versions[1]!.stats?.stopReason).toBe('eosFound')
  })

  it('удалённый во время стрима диалог не воскресает', async () => {
    script = async (_req, _body, res) => {
      for (let i = 0; i < 200 && !res.destroyed; i++) {
        sse(res, delta(`т${i} `))
        await sleep(5)
      }
    }
    const c = await newChat()
    const before = doneEvents().length
    await invoke('chat:generate', { conversationId: c.id, prediction: DEFAULT_PREDICTION_CONFIG })
    await waitFor(() => h.events.some((e) => e.channel === 'chat:delta' && (e.payload as ChatDelta).content))
    await invoke('chat:delete', c.id)
    await waitFor(() => doneEvents().length > before)
    await sleep(50)
    expect(await getConversation(c.id)).toBeNull()
    expect(existsSync(join(h.dir, 'chats', `${c.id}.json`))).toBe(false)
  })

  it('удаление другого диалога не останавливает генерацию', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    script = async (_req, _body, res) => {
      sse(res, delta('А'))
      await gate
      sse(res, delta('Б'))
      sse(res, finishChunk)
    }
    const other = await newChat('другой')
    const c = await newChat()
    const before = doneEvents().length
    await invoke('chat:generate', { conversationId: c.id, prediction: DEFAULT_PREDICTION_CONFIG })
    await invoke('chat:delete', other.id)
    release()
    await waitFor(() => doneEvents().length > before)
    const v = (await getConversation(c.id))!.messages[1]!.versions[0]!
    expect(v.content).toBe('АБ')
    expect(v.stats?.stopReason).toBe('eosFound')
  })

  it('шаблон сам открыл <think>: рассуждение до «голого» </think> уходит в reasoning', async () => {
    script = async (_req, _body, res) => {
      for (const p of ['Надо', ' сложить', ' числа.</th', 'ink>\n\n', 'Ответ: 4']) sse(res, delta(p))
      sse(res, finishChunk)
    }
    const c = await newChat('2+2?')
    const updatesBefore = h.events.filter((e) => e.channel === 'chat:updated').length
    await generateAndWait({ conversationId: c.id })
    const v = (await getConversation(c.id))!.messages[1]!.versions[0]!
    expect(v.reasoning).toBe('Надо сложить числа.')
    expect(v.content).toBe('Ответ: 4')
    // Интерфейс получил исправленную копию посреди стрима.
    expect(h.events.filter((e) => e.channel === 'chat:updated').length).toBeGreaterThan(updatesBefore + 1)
  })

  it('«Продолжить» дописывает ответ без лишних пробелов и без режима рассуждений', async () => {
    script = async (_req, _body, res) => {
      sse(res, delta(' мир'))
      sse(res, finishChunk)
    }
    const c = await newChat()
    const conv: Conversation = {
      ...c,
      messages: [
        ...c.messages,
        { id: 'a1', role: 'assistant', versions: [{ content: 'Привет,', createdAt: 2, error: 'старая ошибка' }], activeVersion: 0 }
      ]
    }
    await invoke('chat:save', conv)
    const done = await generateAndWait({ conversationId: c.id, continueMessageId: 'a1' })
    expect(done.error).toBeUndefined()
    const v = (await getConversation(c.id))!.messages[1]!.versions[0]!
    expect(v.content).toBe('Привет, мир')
    expect(v.error).toBeUndefined()
    const req = requests.find((r) => r.url === '/v1/chat/completions')!
    expect((req.body.chat_template_kwargs as { enable_thinking: boolean }).enable_thinking).toBe(false)
    const msgs = req.body.messages as Array<{ role: string; content: string }>
    expect(msgs[msgs.length - 1]).toEqual({ role: 'assistant', content: 'Привет,' })
  })

  it('TabbyAPI: продолжение уходит как response_prefix', async () => {
    h.engine!.engine = 'exl3'
    script = async (_req, _body, res) => {
      sse(res, delta(' мир'))
      sse(res, { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 1 } })
    }
    const c = await newChat()
    await invoke('chat:save', {
      ...c,
      messages: [...c.messages, { id: 'a1', role: 'assistant', versions: [{ content: 'Привет,', createdAt: 2 }], activeVersion: 0 }]
    })
    await generateAndWait({ conversationId: c.id, continueMessageId: 'a1' })
    const req = requests.find((r) => r.url === '/v1/chat/completions')!
    expect(req.body.response_prefix).toBe('Привет,')
    const msgs = req.body.messages as Array<{ role: string }>
    expect(msgs[msgs.length - 1]!.role).toBe('user')
    const v = (await getConversation(c.id))!.messages[1]!.versions[0]!
    expect(v.content).toBe('Привет, мир')
    expect(v.stats).toMatchObject({ promptTokens: 5, completionTokens: 1 })
  })

  it('оборванный движком стрим — ошибка, а не «готово»', async () => {
    script = async (_req, _body, res) => {
      sse(res, delta('Нача'))
      res.destroy()
    }
    const c = await newChat()
    const done = await generateAndWait({ conversationId: c.id })
    expect(done.error).toMatch(/Движок/)
    expect((await getConversation(c.id))!.messages[1]!.versions[0]!.stats?.stopReason).toBe('failed')
  })

  it('недоступный движок — понятная ошибка', async () => {
    const saved = h.engine!.baseUrl
    // Свободный порт: открыть и сразу закрыть.
    const tmp = createServer()
    await new Promise<void>((r) => tmp.listen(0, '127.0.0.1', r))
    const port = (tmp.address() as { port: number }).port
    await new Promise<void>((r) => tmp.close(() => r()))
    h.engine!.baseUrl = `http://127.0.0.1:${port}`
    try {
      const c = await newChat()
      const done = await generateAndWait({ conversationId: c.id })
      expect(done.error).toMatch(/Движок недоступен/)
    } finally {
      h.engine!.baseUrl = saved
    }
  })

  it('картинки старых сообщений не мешают модели без зрения, новая — ошибка', async () => {
    const img = { id: 'i1', kind: 'image' as const, name: 'a.png', mime: 'image/png', storedPath: join(h.dir, 'x.png'), sizeBytes: 1 }
    const c = await newChat()
    await invoke('chat:save', {
      ...c,
      messages: [
        { ...c.messages[0]!, attachments: [img] },
        { id: 'a1', role: 'assistant', versions: [{ content: 'Вижу', createdAt: 2 }], activeVersion: 0 },
        { id: 'u2', role: 'user', versions: [{ content: 'А теперь?', createdAt: 3 }], activeVersion: 0 }
      ]
    })
    expect((await generateAndWait({ conversationId: c.id })).error).toBeUndefined()

    const c2 = await newChat()
    await invoke('chat:save', { ...c2, messages: [{ ...c2.messages[0]!, attachments: [img] }] })
    expect((await generateAndWait({ conversationId: c2.id })).error).toMatch(/не поддерживает изображения/)
  })

  it('второй запрос во время генерации отклоняется, перегенерация — только ответа модели', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    script = async (_req, _body, res) => {
      await gate
      sse(res, finishChunk)
    }
    const c = await newChat()
    const before = doneEvents().length
    const first = invoke('chat:generate', { conversationId: c.id, prediction: DEFAULT_PREDICTION_CONFIG })
    await expect(invoke('chat:generate', { conversationId: c.id, prediction: DEFAULT_PREDICTION_CONFIG })).rejects.toThrow(
      /уже идёт/
    )
    await first
    release()
    await waitFor(() => doneEvents().length > before)
    await expect(
      invoke('chat:generate', { conversationId: c.id, regenerateMessageId: 'u1', prediction: DEFAULT_PREDICTION_CONFIG })
    ).rejects.toThrow(/только ответ модели/)
  })

  it('chat:save отклоняет небезопасный id', async () => {
    await expect(invoke('chat:save', { id: '../evil', messages: [] })).rejects.toThrow(/идентификатор/)
    await expect(invoke('chat:delete', '..\\x')).rejects.toThrow(/идентификатор/)
  })
})
