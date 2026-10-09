// Подключение модулей main-процесса. Каждый модуль регистрирует свои IPC-обработчики.
import { registerHardwareIpc } from './hardware'
import { registerModelsIpc } from './models/registry'
import { registerEngineIpc, shutdownEngines } from './engines/manager'
import { registerHfIpc, shutdownDownloads } from './hf'

export async function registerModules(): Promise<void> {
  registerHardwareIpc()
  registerModelsIpc()
  registerEngineIpc()
  registerHfIpc()
}

export async function shutdownModules(): Promise<void> {
  await Promise.allSettled([shutdownEngines(), shutdownDownloads()])
}
