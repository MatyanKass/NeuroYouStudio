import { handle } from '../ipc'
import { activeEngine } from '../engines/manager'
import {
  createConversation,
  deleteConversation,
  duplicateConversation,
  getConversation,
  listConversations,
  saveConversation
} from './store'
import { generate, isGenerating, stopGeneration } from './generate'
import { countTokens } from './tokens'

export function registerChatIpc(): void {
  handle('chat:list', () => listConversations())
  handle('chat:get', (id) => getConversation(id))
  handle('chat:create', (folder) => createConversation(folder))
  handle('chat:save', (c) => saveConversation(c))
  handle('chat:delete', async (id) => {
    if (isGenerating()) stopGeneration()
    await deleteConversation(id)
  })
  handle('chat:duplicate', (id, upto) => duplicateConversation(id, upto))
  handle('chat:generate', (req) => generate(req))
  handle('chat:stop', () => stopGeneration())
  handle('chat:countTokens', (text) => countTokens(activeEngine(), text))
  handle('chat:autoTitle', async (id) => (await getConversation(id))?.title ?? null)
}

export function shutdownChat(): void {
  stopGeneration()
}
