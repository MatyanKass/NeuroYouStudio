import type { Conversation } from '@shared/types'
import { handle } from '../ipc'
import { activeEngine } from '../engines/manager'
import {
  assertConversationId,
  createConversation,
  deleteConversation,
  duplicateConversation,
  getConversation,
  listConversations,
  saveConversation
} from './store'
import { generate, generatingConversationId, reconcileIncoming, stopGeneration } from './generate'
import { countTokens } from './tokens'

export function registerChatIpc(): void {
  handle('chat:list', () => listConversations())
  handle('chat:get', (id) => getConversation(id))
  handle('chat:create', (folder) => createConversation(folder))
  handle('chat:save', async (c: Conversation) => {
    if (!c || typeof c !== 'object' || !Array.isArray(c.messages)) throw new Error('Некорректный диалог')
    assertConversationId(c.id)
    await saveConversation(reconcileIncoming(c, await getConversation(c.id)))
  })
  handle('chat:delete', async (id) => {
    assertConversationId(id)
    // Останавливаем генерацию только если она идёт в удаляемом диалоге.
    if (generatingConversationId() === id) stopGeneration()
    await deleteConversation(id)
  })
  handle('chat:duplicate', (id, upto) => duplicateConversation(id, upto))
  handle('chat:generate', (req) => {
    assertConversationId(req?.conversationId)
    return generate(req)
  })
  handle('chat:stop', () => stopGeneration())
  handle('chat:countTokens', (text) => countTokens(activeEngine(), typeof text === 'string' ? text : ''))
  handle('chat:autoTitle', async (id) => (await getConversation(id))?.title ?? null)
}

export function shutdownChat(): void {
  stopGeneration()
}
