import { app } from 'electron'
import { join } from 'node:path'
import { mkdirSync } from 'node:fs'

function ensure(dir: string): string {
  mkdirSync(dir, { recursive: true })
  return dir
}

/** %APPDATA%\NeuroYouStudio — настройки, чаты, пресеты. */
export const userDataDir = (): string => ensure(app.getPath('userData'))
export const chatsDir = (): string => ensure(join(userDataDir(), 'chats'))
export const presetsDir = (): string => ensure(join(userDataDir(), 'presets'))
export const attachmentsDir = (): string => ensure(join(userDataDir(), 'attachments'))
export const ragCacheDir = (): string => ensure(join(userDataDir(), 'rag-cache'))

/** %LOCALAPPDATA%\NeuroYouStudio — тяжёлые движки, логи. */
export const localDataDir = (): string =>
  ensure(join(process.env.LOCALAPPDATA ?? app.getPath('userData'), 'NeuroYouStudio'))
export const runtimesDir = (): string => ensure(join(localDataDir(), 'runtimes'))
export const logsDir = (): string => ensure(join(localDataDir(), 'logs'))
export const tmpDownloadsDir = (): string => ensure(join(localDataDir(), 'tmp'))

/** Папка моделей по умолчанию: %USERPROFILE%\NeuroYouStudio\models. */
export const defaultModelsDir = (): string => join(app.getPath('home'), 'NeuroYouStudio', 'models')
