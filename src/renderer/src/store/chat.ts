import { create } from 'zustand'
import type { Attachment, ChatMessage, Conversation, ConversationSummary } from '@shared/types'
import { call, subscribe } from '@/lib/api'
import { useSettings } from './app'

interface ChatState {
  list: ConversationSummary[]
  currentId: string | null
  current: Conversation | null
  /** id сообщения, в которое сейчас идёт генерация. */
  streamingId: string | null
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

function prediction(): NonNullable<ReturnType<typeof useSettings.getState>['settings']>['defaultPrediction'] {
  const s = useSettings.getState().settings
  if (!s) throw new Error('Настройки ещё не загружены')
  return s.defaultPrediction
}

async function persist(c: Conversation): Promise<void> {
  await call('chat:save', c)
}

export const useChat = create<ChatState>((set, get) => ({
  list: [],
  currentId: null,
  current: null,
  streamingId: null,
  error: null,

  refreshList: async () => set({ list: await call('chat:list') }),

  open: async (id) => {
    const c = await call('chat:get', id)
    set({ currentId: id, current: c, error: null })
  },

  create: async () => {
    // Пустой новый чат держим только один (как в LM Studio).
    const empty = get().list.find((c) => c.messageCount === 0)
    if (empty) return get().open(empty.id)
    const c = await call('chat:create')
    set({ currentId: c.id, current: c, error: null })
    await get().refreshList()
  },

  remove: async (id) => {
    await call('chat:delete', id)
    await get().refreshList()
    if (get().currentId === id) {
      const next = get().list[0]
      if (next) await get().open(next.id)
      else set({ currentId: null, current: null })
    }
  },

  rename: async (id, title) => {
    const c = id === get().currentId ? get().current : await call('chat:get', id)
    if (!c) return
    const next = { ...c, title: title.trim() || c.title }
    await persist(next)
    if (id === get().currentId) set({ current: next })
    await get().refreshList()
  },

  duplicate: async (id, upto) => {
    const c = await call('chat:duplicate', id, upto)
    await get().refreshList()
    set({ currentId: c.id, current: c })
  },

  send: async (text, attachments) => {
    let c = get().current
    if (!c) {
      c = await call('chat:create')
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
    set({ current: next, error: null })
    await persist(next)
    try {
      await call('chat:generate', { conversationId: next.id, prediction: prediction() })
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) })
    }
  },

  regenerate: async (messageId) => {
    const c = get().current
    if (!c) return
    set({ error: null })
    try {
      await call('chat:generate', { conversationId: c.id, regenerateMessageId: messageId, prediction: prediction() })
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) })
    }
  },

  continueMessage: async (messageId) => {
    const c = get().current
    if (!c) return
    set({ error: null })
    try {
      await call('chat:generate', { conversationId: c.id, continueMessageId: messageId, prediction: prediction() })
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) })
    }
  },

  stop: async () => {
    await call('chat:stop')
  },

  editMessage: async (messageId, text, resend) => {
    const c = get().current
    if (!c) return
    const idx = c.messages.findIndex((m) => m.id === messageId)
    if (idx < 0) return
    const m = c.messages[idx]!
    const versions = m.versions.slice()
    versions[m.activeVersion] = { ...versions[m.activeVersion]!, content: text }
    let messages = c.messages.slice()
    messages[idx] = { ...m, versions }
    // Правка реплики пользователя с повторной отправкой обрезает всё после неё.
    if (resend && m.role === 'user') messages = messages.slice(0, idx + 1)
    const next = { ...c, messages }
    set({ current: next })
    await persist(next)
    if (resend && m.role === 'user') {
      try {
        await call('chat:generate', { conversationId: c.id, prediction: prediction() })
      } catch (e) {
        set({ error: e instanceof Error ? e.message : String(e) })
      }
    }
  },

  deleteMessage: async (messageId) => {
    const c = get().current
    if (!c) return
    const next = { ...c, messages: c.messages.filter((m) => m.id !== messageId) }
    set({ current: next })
    await persist(next)
    await get().refreshList()
  },

  switchVersion: async (messageId, delta) => {
    const c = get().current
    if (!c) return
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
}))

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
      useChat.setState({ streamingId: null })
      if (d.error && d.conversationId === s.currentId) useChat.setState({ error: d.error })
      return
    }
    if (s.streamingId !== d.messageId) useChat.setState({ streamingId: d.messageId })
    const c = s.current
    if (!c || c.id !== d.conversationId) return
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
  if (first) await useChat.getState().open(first.id)
}
