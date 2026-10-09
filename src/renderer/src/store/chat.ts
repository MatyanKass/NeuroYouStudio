import { create } from 'zustand'
import type { Attachment, ChatMessage, Conversation, ConversationSummary, GenerateRequest } from '@shared/types'
import { call, subscribe } from '@/lib/api'
import { useSettings } from './app'

interface ChatState {
  list: ConversationSummary[]
  currentId: string | null
  current: Conversation | null
  /** id сообщения, в которое сейчас идёт генерация. */
  streamingId: string | null
  /** Диалог, в котором идёт генерация: с отправки запроса до последней дельты. */
  activeConvId: string | null
  error: string | null
  refreshList: () => Promise<void>
  open: (id: string) => Promise<void>
  create: () => Promise<void>
  remove: (id: string) => Promise<void>
  rename: (id: string, title: string) => Promise<void>
  duplicate: (id: string, uptoMessageId?: string) => Promise<void>
  send: (text: string, attachments: Attachment[]) => Promise<void>
  regenerate: (messageId: string) => Promise<void>
  continueMessage: (messageId: string) => Promise<void>
  stop: () => Promise<void>
  editMessage: (messageId: string, text: string, resend: boolean) => Promise<void>
  deleteMessage: (messageId: string) => Promise<void>
  switchVersion: (messageId: string, delta: number) => Promise<void>
  setError: (e: string | null) => void
}

const newMsgId = (): string => `m${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e))

function prediction(): NonNullable<ReturnType<typeof useSettings.getState>['settings']>['defaultPrediction'] {
  const s = useSettings.getState().settings
  if (!s) throw new Error('Настройки ещё не загружены')
  return s.defaultPrediction
}

async function persist(c: Conversation): Promise<void> {
  await call('chat:save', c)
}

// Main сливает ответ с последней сохранённой копией, но переименование и удаление
// генерирующегося диалога всё равно откладываем до конца генерации — так проще и предсказуемее.
const idleWaiters: Array<() => void> = []

function waitIdle(convId: string, timeoutMs = 15_000): Promise<void> {
  if (useChat.getState().activeConvId !== convId) return Promise.resolve()
  return new Promise((resolve) => {
    const t = setTimeout(resolve, timeoutMs)
    idleWaiters.push(() => {
      clearTimeout(t)
      resolve()
    })
  })
}

function markIdle(): void {
  useChat.setState({ streamingId: null, activeConvId: null })
  idleWaiters.splice(0).forEach((w) => w())
}

let openSeq = 0
/** Удалённые диалоги: отложенное переименование не должно воскресить их сохранением. */
const removed = new Set<string>()

export const useChat = create<ChatState>((set, get) => {
  /** Запрос генерации. Слот занят с этого момента, чтобы не отправить второй запрос до первой дельты. */
  const generate = async (req: Omit<GenerateRequest, 'prediction'>): Promise<void> => {
    set({ activeConvId: req.conversationId, error: null })
    try {
      await call('chat:generate', { ...req, prediction: prediction() })
    } catch (e) {
      // Генерация не началась (нет модели, уже идёт другая и т. п.).
      if (!get().streamingId) markIdle()
      set({ error: errText(e) })
    }
  }

  return {
    list: [],
    currentId: null,
    current: null,
    streamingId: null,
    activeConvId: null,
    error: null,

    refreshList: async () => set({ list: await call('chat:list') }),

    open: async (id) => {
      // При быстрых переключениях показываем только последний открытый диалог.
      const seq = ++openSeq
      const c = await call('chat:get', id)
      if (seq !== openSeq) return
      set({ currentId: id, current: c, error: null })
    },

    create: async () => {
      // Пустой новый чат держим только один (как в LM Studio).
      const empty = get().list.find((c) => c.messageCount === 0)
      if (empty) return get().open(empty.id)
      const c = await call('chat:create')
      ++openSeq
      set({ currentId: c.id, current: c, error: null })
      await get().refreshList()
    },

    remove: async (id) => {
      removed.add(id)
      if (get().activeConvId === id) {
        await call('chat:stop')
        await waitIdle(id)
      }
      await call('chat:delete', id)
      await get().refreshList()
      if (get().currentId === id) {
        const next = get().list[0]
        if (next) await get().open(next.id)
        else {
          ++openSeq
          set({ currentId: null, current: null })
        }
      }
    },

    rename: async (id, title) => {
      const t = title.trim()
      if (!t) return
      const cur = get().current
      if (id === get().currentId && cur) set({ current: { ...cur, title: t } })
      await waitIdle(id)
      if (removed.has(id)) return
      // Свежая копия из main: в ней уже весь сгенерированный ответ.
      const c = await call('chat:get', id)
      if (!c || removed.has(id)) return
      const next = { ...c, title: t }
      await persist(next)
      if (id === get().currentId) set({ current: next })
      await get().refreshList()
    },

    duplicate: async (id, upto) => {
      const c = await call('chat:duplicate', id, upto)
      await get().refreshList()
      ++openSeq
      set({ currentId: c.id, current: c, error: null })
    },

    send: async (text, attachments) => {
      if (get().activeConvId) return
      let c = get().current
      if (!c) {
        c = await call('chat:create')
        ++openSeq
        set({ currentId: c.id, current: c })
      }
      const msg: ChatMessage = {
        id: newMsgId(),
        role: 'user',
        versions: [{ content: text, createdAt: Date.now() }],
        activeVersion: 0,
        attachments: attachments.length ? attachments : undefined
      }
      const next = { ...c, messages: [...c.messages, msg] }
      set({ current: next, error: null, activeConvId: next.id })
      try {
        await persist(next)
      } catch (e) {
        markIdle()
        set({ error: errText(e) })
        return
      }
      await generate({ conversationId: next.id })
    },

    regenerate: async (messageId) => {
      const c = get().current
      if (!c || get().activeConvId) return
      await generate({ conversationId: c.id, regenerateMessageId: messageId })
    },

    continueMessage: async (messageId) => {
      const c = get().current
      if (!c || get().activeConvId) return
      await generate({ conversationId: c.id, continueMessageId: messageId })
    },

    stop: async () => {
      await call('chat:stop')
    },

    editMessage: async (messageId, text, resend) => {
      const c = get().current
      if (!c || get().activeConvId === c.id) return
      const idx = c.messages.findIndex((m) => m.id === messageId)
      if (idx < 0) return
      const m = c.messages[idx]!
      const versions = m.versions.slice()
      versions[m.activeVersion] = { ...versions[m.activeVersion]!, content: text }
      let messages = c.messages.slice()
      messages[idx] = { ...m, versions }
      // Правка реплики пользователя с повторной отправкой обрезает всё после неё.
      const regen = resend && m.role === 'user' && !get().activeConvId
      if (regen) messages = messages.slice(0, idx + 1)
      const next = { ...c, messages }
      set({ current: next })
      await persist(next)
      if (regen) await generate({ conversationId: c.id })
    },

    deleteMessage: async (messageId) => {
      const c = get().current
      if (!c || get().activeConvId === c.id) return
      const next = { ...c, messages: c.messages.filter((m) => m.id !== messageId) }
      set({ current: next })
      await persist(next)
      await get().refreshList()
    },

    switchVersion: async (messageId, delta) => {
      const c = get().current
      if (!c || get().activeConvId === c.id) return
      const messages = c.messages.map((m) => {
        if (m.id !== messageId) return m
        const v = Math.max(0, Math.min(m.versions.length - 1, m.activeVersion + delta))
        return { ...m, activeVersion: v }
      })
      const next = { ...c, messages }
      set({ current: next })
      await persist(next)
    },

    setError: (error) => set({ error })
  }
})

let started = false

export async function initChat(): Promise<void> {
  if (started) return
  started = true
  subscribe('chat:updated', (c) => {
    const s = useChat.getState()
    if (c.id === s.currentId) useChat.setState({ current: c })
    void s.refreshList()
  })
  subscribe('chat:delta', (d) => {
    const s = useChat.getState()
    if (d.done) {
      // Текст ошибки main кладёт в само сообщение (version.error) — плашкой не дублируем.
      markIdle()
      return
    }
    if (s.streamingId !== d.messageId || s.activeConvId !== d.conversationId) {
      useChat.setState({ streamingId: d.messageId, activeConvId: d.conversationId })
    }
    const c = s.current
    if (!c || c.id !== d.conversationId || (!d.content && !d.reasoning)) return
    const messages = c.messages.map((m) => {
      if (m.id !== d.messageId) return m
      const versions = m.versions.slice()
      const v = { ...versions[m.activeVersion]! }
      if (d.content) v.content += d.content
      if (d.reasoning) v.reasoning = (v.reasoning ?? '') + d.reasoning
      versions[m.activeVersion] = v
      return { ...m, versions }
    })
    useChat.setState({ current: { ...c, messages } })
  })
  await useChat.getState().refreshList()
  const first = useChat.getState().list[0]
  if (first && !useChat.getState().currentId) await useChat.getState().open(first.id)
}
