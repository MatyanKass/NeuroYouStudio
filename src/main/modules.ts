// Подключение модулей main-процесса. Каждый модуль регистрирует свои IPC-обработчики.
import { registerHardwareIpc } from './hardware'
import { registerModelsIpc } from './models/registry'
import { registerEngineIpc, shutdownEngines } from './engines/manager'
import { registerHfIpc, shutdownDownloads } from './hf'
import { registerChatIpc, shutdownChat } from './chat'
import { registerPresetsIpc } from './presets'
import { registerAttachmentsIpc } from './attachments'
import { registerAgentIpc, shutdownAgent } from './agent'

export async function registerModules(): Promise<void> {
  registerHardwareIpc()
  registerModelsIpc()
  registerEngineIpc()
  registerHfIpc()
  registerChatIpc()
  registerPresetsIpc()
  registerAttachmentsIpc()
  registerAgentIpc()
}

export async function shutdownModules(): Promise<void> {
  shutdownChat()
  await Promise.allSettled([shutdownAgent(), shutdownEngines(), shutdownDownloads()])
}
