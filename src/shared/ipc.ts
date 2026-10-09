// Типизированный контракт IPC между main и renderer.
// Ключ — имя канала, значение — сигнатура обработчика в main.

import type { DeepPartial, LoadConfig, ModelFormat } from './config'
import type {
  AppInfo,
  AppSettings,
  Attachment,
  ChatDelta,
  Conversation,
  ConversationSummary,
  DownloadItem,
  EngineStatus,
  GenerateRequest,
  HardwareInfo,
  HardwareLive,
  HfModelDetails,
  HfModelSummary,
  LocalModel,
  MemoryPlan,
  Preset,
  RuntimeDescriptor,
  TaskProgress
} from './types'

export interface HfSearchQuery {
  query: string
  format: ModelFormat
  sort: 'downloads' | 'likes' | 'lastModified' | 'trendingScore'
  limit?: number
}

export interface IpcInvokeMap {
  'app:info': () => AppInfo
  'app:openPath': (path: string) => void
  'app:openExternal': (url: string) => void
  'app:pickFolder': (title: string) => string | null
  'app:diagnostics': () => string

  'settings:get': () => AppSettings
  'settings:update': (patch: DeepPartial<AppSettings>) => AppSettings
  'settings:setPerModelLoad': (modelId: string, load: Partial<LoadConfig> | null) => AppSettings
  'settings:setHfToken': (token: string | null) => AppSettings

  'hardware:get': () => HardwareInfo

  'models:list': (rescan?: boolean) => LocalModel[]
  'models:delete': (modelId: string) => void

  'memory:plan': (modelId: string, load: LoadConfig) => MemoryPlan

  'engine:status': () => EngineStatus
  'engine:load': (modelId: string, load: LoadConfig) => EngineStatus
  'engine:unload': () => EngineStatus
  'engine:logs': () => string[]

  'runtimes:list': () => RuntimeDescriptor[]
  'runtimes:install': (runtimeId: string) => void
  'runtimes:remove': (runtimeId: string) => void
  'runtimes:select': (runtimeId: string) => AppSettings

  'chat:list': () => ConversationSummary[]
  'chat:get': (id: string) => Conversation | null
  'chat:create': (folder?: string) => Conversation
  'chat:save': (conversation: Conversation) => void
  'chat:delete': (id: string) => void
  'chat:duplicate': (id: string, uptoMessageId?: string) => Conversation
  'chat:generate': (req: GenerateRequest) => void
  'chat:stop': () => void
  'chat:countTokens': (text: string) => number
  'chat:autoTitle': (id: string) => string | null

  'attachments:pick': () => string[]
  'attachments:add': (paths: string[]) => Attachment[]
  'attachments:addData': (name: string, mime: string, base64: string) => Attachment
  /** Миниатюра картинки как data URL. */
  'attachments:preview': (attachment: Attachment, maxDim: number) => string

  'presets:list': () => Preset[]
  'presets:save': (preset: Preset) => Preset[]
  'presets:delete': (id: string) => Preset[]
  'presets:import': () => Preset[]
  'presets:export': (id: string) => void

  'hf:search': (q: HfSearchQuery) => HfModelSummary[]
  'hf:details': (repoId: string, format: ModelFormat) => HfModelDetails
  'downloads:start': (repoId: string, format: ModelFormat, optionKey: string, withMmproj?: string) => void
  'downloads:list': () => DownloadItem[]
  'downloads:pause': (id: string) => void
  'downloads:resume': (id: string) => void
  'downloads:cancel': (id: string) => void
  'downloads:clearFinished': () => void
}

export interface IpcEventMap {
  'hardware:live': HardwareLive
  'engine:status': EngineStatus
  'engine:log': string
  'chat:delta': ChatDelta
  'chat:updated': Conversation
  'downloads:update': DownloadItem[]
  'runtimes:progress': TaskProgress
  'models:changed': LocalModel[]
  'settings:changed': AppSettings
}

export type InvokeChannel = keyof IpcInvokeMap
export type EventChannel = keyof IpcEventMap

export interface NysApi {
  invoke<K extends InvokeChannel>(
    channel: K,
    ...args: Parameters<IpcInvokeMap[K]>
  ): Promise<Awaited<ReturnType<IpcInvokeMap[K]>>>
  on<K extends EventChannel>(channel: K, cb: (payload: IpcEventMap[K]) => void): () => void
  /** Путь к файлу, перетащенному в окно (Electron webUtils). */
  pathForFile(file: File): string
}
