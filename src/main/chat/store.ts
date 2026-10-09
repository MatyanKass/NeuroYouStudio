import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import type { Conversation, ConversationSummary } from '@shared/types'
import { chatsDir } from '../paths'
import { readJson, writeJson } from '../util/json-file'
import { newId } from '../util/id'

// Диалоги хранятся по одному JSON-файлу (как в LM Studio: ~/.lmstudio/conversations).

const cache = new Map<string, Conversation>()
let indexed = false

const fileOf = (id: string): string => join(chatsDir(), `${id.replace(/[^\w-]/g, '')}.json`)

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

async function ensureIndexed(): Promise<void> {
  if (indexed) return
  const files = await fs.readdir(chatsDir()).catch(() => [] as string[])
  for (const f of files) {
    if (!f.endsWith('.json')) continue
    const c = await readJson<Conversation | null>(join(chatsDir(), f), null)
    if (c?.id && Array.isArray(c.messages)) cache.set(c.id, c)
  }
  indexed = true
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
  const c: Conversation = { id: newId('c'), title: 'Новый чат', folder, createdAt: now, updatedAt: now, messages: [] }
  cache.set(c.id, c)
  await writeJson(fileOf(c.id), c)
  return c
}

export async function saveConversation(c: Conversation, touch = true): Promise<void> {
  await ensureIndexed()
  const next = touch ? { ...c, updatedAt: Date.now() } : c
  cache.set(c.id, next)
  await writeJson(fileOf(c.id), next)
}

export async function deleteConversation(id: string): Promise<void> {
  await ensureIndexed()
  cache.delete(id)
  await fs.rm(fileOf(id), { force: true })
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
