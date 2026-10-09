import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import type { ChatMessage, Conversation, ConversationSummary } from '@shared/types'
import { chatsDir } from '../paths'
import { readJson, writeJson } from '../util/json-file'
import { newId } from '../util/id'

// Диалоги хранятся по одному JSON-файлу (как в LM Studio: ~/.lmstudio/conversations).

const cache = new Map<string, Conversation>()
/** Удалённые в этом сеансе: запоздалое сохранение (конец стрима) не должно их воскрешать. */
const deleted = new Set<string>()
let indexing: Promise<void> | null = null

const ID_RE = /^[\w-]{1,128}$/

export function assertConversationId(id: unknown): asserts id is string {
  if (typeof id !== 'string' || !ID_RE.test(id)) throw new Error('Некорректный идентификатор диалога')
}

const fileOf = (id: string): string => join(chatsDir(), `${id}.json`)

function summarize(c: Conversation): ConversationSummary {
  return {
    id: c.id,
    title: c.title,
    folder: c.folder,
    updatedAt: c.updatedAt,
    messageCount: c.messages.length,
    pinned: c.pinned
  }
}

function isConversation(c: unknown): c is Conversation {
  const x = c as Partial<Conversation> | null
  return Boolean(
    x && typeof x === 'object' && typeof x.id === 'string' && ID_RE.test(x.id) && Array.isArray(x.messages)
  )
}

function ensureIndexed(): Promise<void> {
  indexing ??= (async () => {
    const files = await fs.readdir(chatsDir()).catch(() => [] as string[])
    for (const f of files) {
      if (!f.endsWith('.json')) continue
      const c = await readJson<Conversation | null>(join(chatsDir(), f), null)
      // Уже сохранённое за время индексации свежее того, что на диске.
      if (isConversation(c) && !cache.has(c.id) && !deleted.has(c.id)) cache.set(c.id, c)
    }
  })()
  return indexing
}

export async function listConversations(): Promise<ConversationSummary[]> {
  await ensureIndexed()
  return [...cache.values()].map(summarize).sort((a, b) => b.updatedAt - a.updatedAt)
}

export async function getConversation(id: string): Promise<Conversation | null> {
  await ensureIndexed()
  return cache.get(id) ?? null
}

export async function createConversation(folder = ''): Promise<Conversation> {
  await ensureIndexed()
  const now = Date.now()
  const c: Conversation = {
    id: newId('c'),
    title: 'Новый чат',
    folder: typeof folder === 'string' ? folder : '',
    createdAt: now,
    updatedAt: now,
    messages: []
  }
  cache.set(c.id, c)
  await writeJson(fileOf(c.id), c)
  return c
}

/**
 * Сохраняет диалог и возвращает сохранённый объект (он же лежит в кэше).
 * Удалённый диалог не сохраняется — возвращается null.
 */
export async function saveConversation(c: Conversation, touch = true): Promise<Conversation | null> {
  if (!isConversation(c)) throw new Error('Некорректный диалог')
  await ensureIndexed()
  if (deleted.has(c.id)) return null
  const next = touch ? { ...c, updatedAt: Date.now() } : c
  cache.set(c.id, next)
  await writeJson(fileOf(c.id), next)
  return next
}

export async function deleteConversation(id: string): Promise<void> {
  assertConversationId(id)
  await ensureIndexed()
  deleted.add(id)
  cache.delete(id)
  await fs.rm(fileOf(id), { force: true })
}

/**
 * Защита от устаревшей копии из интерфейса: если в кэше версия ответа уже завершена (есть stats),
 * а пришла та же версия без stats (снимок, сделанный во время стрима), — оставляем завершённую.
 */
export function keepFinishedVersions(incoming: Conversation, cached: Conversation | null | undefined): Conversation {
  if (!cached) return incoming
  const byId = new Map<string, ChatMessage>(cached.messages.map((m) => [m.id, m]))
  for (const m of incoming.messages) {
    const old = byId.get(m.id)
    if (!old || !Array.isArray(m.versions)) continue
    m.versions = m.versions.map((v, i) => {
      const o = old.versions[i]
      return o?.stats && v && !v.stats && v.createdAt === o.createdAt ? o : v
    })
  }
  return incoming
}

/** Копия диалога; uptoMessageId — «ветка» до этого сообщения включительно. */
export async function duplicateConversation(id: string, uptoMessageId?: string): Promise<Conversation> {
  const src = await getConversation(id)
  if (!src) throw new Error('Диалог не найден')
  let messages = src.messages
  if (uptoMessageId) {
    const idx = messages.findIndex((m) => m.id === uptoMessageId)
    if (idx >= 0) messages = messages.slice(0, idx + 1)
  }
  const now = Date.now()
  const copy: Conversation = {
    ...structuredClone(src),
    id: newId('c'),
    title: uptoMessageId ? `${src.title} (ветка)` : `${src.title} (копия)`,
    createdAt: now,
    updatedAt: now,
    messages: structuredClone(messages)
  }
  cache.set(copy.id, copy)
  await writeJson(fileOf(copy.id), copy)
  return copy
}

/** Простое название из первого сообщения пользователя. */
export function titleFromText(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim()
  if (!line) return 'Новый чат'
  return line.length > 48 ? `${line.slice(0, 47)}…` : line
}
