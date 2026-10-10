import type {
  AgentSettings,
  EngineChoice,
  EngineId,
  LoadConfig,
  MemoryLayout,
  ModelFormat,
  Place,
  PredictionConfig
} from './config'

// ---------- Железо ----------

export interface GpuInfo {
  index: number
  name: string
  vramTotalMiB: number
  vramFreeMiB: number
  driverVersion: string
  /** "7.5", "12.0" … */
  computeCap: string
}

export interface HardwareInfo {
  gpus: GpuInfo[]
  ramTotalMiB: number
  ramFreeMiB: number
  cpuName: string
  cpuCores: number
  cpuThreads: number
  avx2: boolean
  avx512: boolean
  /** Максимальная версия CUDA, которую поддерживает драйвер ("13.1"), из шапки nvidia-smi. */
  cudaVersion?: string
}

export interface HardwareLive {
  vramUsedMiB: number
  vramTotalMiB: number
  ramUsedMiB: number
  ramTotalMiB: number
  gpuUtil: number
}

// ---------- Модели ----------

export interface ModelArchInfo {
  arch: string
  nLayers: number
  nEmbd: number
  nHead: number
  nHeadKv: number
  headDimK: number
  headDimV: number
  contextLengthMax: number
  nExperts: number
  nExpertsUsed: number
  /** Слои со скользящим окном (SWA) и размер окна, если есть. */
  slidingWindow: number
  swaLayers: number
  /** MLA (DeepSeek): размер сжатого KV на токен на слой, элементов. */
  mlaKvDim: number
  /** Слои без attention (рекуррентные, Mamba и т.п.) — у них нет KV. */
  recurrentLayers: number
  vocabSize: number
  // Необязательные подробности (memory/planner считает точнее, если они есть):
  /** KV-голов по слоям (0 = у слоя нет KV: рекуррентный или с общим KV). Длина nLayers. */
  layerKvHeads?: number[]
  /** SWA-слои по индексу. Длина nLayers. */
  layerSwa?: boolean[]
  /** Рекуррентные слои по индексу (у них фиксированное состояние вместо KV). */
  layerRecurrent?: boolean[]
  /** Размерности головы у SWA-слоёв, если отличаются от полных (Gemma 4). */
  headDimKSwa?: number
  headDimVSwa?: number
  /** Состояние одного рекуррентного слоя на последовательность, элементов f32. */
  recurrentStateElems?: number
  /** Размер плотного FFN и FFN эксперта — для оценки буферов вычислений. */
  nFf?: number
  nFfExp?: number
  /** MTP/NextN-слои после основных (в GGUF входят в block_count, по умолчанию не грузятся). */
  nextnLayers?: number
}

/** Размеры весов по группам, байты. Слои — массив по индексу блока. */
export interface ModelTensorStats {
  tokenEmbd: number
  output: number
  /** Нормы и прочее вне блоков. */
  other: number
  layers: Array<{ attn: number; ffn: number; experts: number; sharedExperts: number; norm: number }>
  /** output.weight нет — выход = копия эмбеддингов (output выставлен равным tokenEmbd). */
  tiedOutput?: boolean
  /** Веса MTP/NextN-слоёв (по умолчанию не загружаются), байты. */
  mtp?: number
  /** Часть other, которая относится к vision-башне (EXL3 со встроенным зрением). */
  vision?: number
  /** Самый большой одиночный тензор группы (для оценки копий при op-offload). */
  maxTensor?: { attn: number; ffn: number; experts: number; sharedExperts: number }
  /** Всего параметров (элементов) и активных на токен (MoE). */
  nParams?: number
  nParamsActive?: number
}

export interface LocalModel {
  /** Стабильный ключ: путь относительно папки моделей, через '/'. */
  id: string
  format: ModelFormat
  /** Файл .gguf (первый шард) или папка EXL3. */
  path: string
  files: string[]
  sizeBytes: number
  publisher: string
  repo: string
  name: string
  quant: string
  paramsLabel: string
  arch?: ModelArchInfo
  tensors?: ModelTensorStats
  isMoe: boolean
  vision: boolean
  mmprojPath?: string
  /** Размер файла mmproj, байты (для плана памяти). */
  mmprojSizeBytes?: number
  isEmbedding: boolean
  chatTemplate?: string
  /** Для EXL3: биты на вес. */
  bpw?: number
  error?: string
}

// ---------- План памяти ----------

export type MemoryComponentId =
  | 'compute'
  | 'attn'
  | 'ffn'
  | 'experts'
  | 'output'
  | 'embd'
  | 'kv'
  | 'mmproj'
  | 'other'

export interface MemoryComponent {
  id: MemoryComponentId
  label: string
  vramBytes: number
  ramBytes: number
  /** Можно ли переносить между VRAM и RAM в этом движке. */
  movable: boolean
  hint?: string
}

export type FitLevel = 'full' | 'partial' | 'ram' | 'none'

export interface MemoryPlan {
  engine: EngineId
  components: MemoryComponent[]
  vramBytes: number
  ramBytes: number
  vramAvailableBytes: number
  ramAvailableBytes: number
  fit: FitLevel
  /** Конкретная раскладка, которую получит движок. */
  resolved: MemoryLayout
  /** Слоёв в модели. */
  nLayers: number
  warnings: string[]
  /** Аргументы движка, которые получатся из плана (для показа). */
  args: string[]
}

/** Фактическое распределение из логов движка после загрузки, МиБ по устройствам. */
export interface MemoryActual {
  model: Record<string, number>
  kv: Record<string, number>
  compute: Record<string, number>
  output: Record<string, number>
}

// ---------- Движки и рантаймы ----------

export type EngineState = 'idle' | 'starting' | 'loading' | 'ready' | 'stopping' | 'error'

export interface EngineStatus {
  state: EngineState
  engine?: EngineId
  runtimeId?: string
  modelId?: string
  port?: number
  load?: LoadConfig
  plan?: MemoryPlan
  actual?: MemoryActual
  error?: string
  loadProgress?: number
  contextLength?: number
  vision?: boolean
}

export interface RuntimeDescriptor {
  id: string
  engine: EngineId
  title: string
  version: string
  variant: string
  description: string
  downloadBytes: number
  installed: boolean
  installedPath?: string
  /** Подходит ли под текущее железо и почему нет. */
  compatible: boolean
  incompatibleReason?: string
  recommended: boolean
}

export interface TaskProgress {
  id: string
  title: string
  phase: string
  receivedBytes: number
  totalBytes: number
  done: boolean
  error?: string
}

// ---------- HuggingFace ----------

export interface HfModelSummary {
  id: string
  author: string
  downloads: number
  likes: number
  lastModified: string
  tags: string[]
  format: ModelFormat
  /** Закрытая модель (нужно принять условия на HF и указать токен). */
  gated?: boolean
  /** pipeline_tag с HF: text-generation, image-text-to-text… */
  pipelineTag?: string
}

export interface HfFileOption {
  /** Ключ варианта: имя файла (GGUF) или ветка (EXL3). */
  key: string
  label: string
  quant: string
  revision: string
  files: Array<{ path: string; size: number }>
  sizeBytes: number
  fit?: FitLevel
  fitNote?: string
  downloaded: boolean
  isMmproj: boolean
}

export interface HfModelDetails {
  id: string
  format: ModelFormat
  description: string
  options: HfFileOption[]
  mmproj: HfFileOption[]
  gated: boolean
}

export interface DownloadItem extends TaskProgress {
  repo: string
  optionKey: string
  state: 'queued' | 'downloading' | 'paused' | 'done' | 'error' | 'canceled'
  speedBps: number
  targetPath: string
}

// ---------- Чат ----------

export type StopReason =
  | 'eosFound'
  | 'stopStringFound'
  | 'maxPredictedTokensReached'
  | 'contextLengthReached'
  | 'userStopped'
  | 'modelUnloaded'
  | 'failed'

export interface GenerationStats {
  tokensPerSecond: number
  timeToFirstTokenMs: number
  promptTokens: number
  completionTokens: number
  promptTokensPerSecond?: number
  stopReason: StopReason
  draftAccepted?: number
  draftTotal?: number
}

export interface Attachment {
  id: string
  kind: 'image' | 'document'
  name: string
  mime: string
  /** Копия файла в папке приложения. */
  storedPath: string
  sizeBytes: number
  /** Для документов: сколько токенов/символов извлечено. */
  textChars?: number
  /** Как документ попал в контекст при последней генерации. */
  injection?: 'full' | 'rag'
}

// ---------- Агент ----------

export type ToolName = 'read_file' | 'list_dir' | 'search_files' | 'write_file' | 'edit_file' | 'run_command'

/** Вердикт охранника (модели) или жёстких правил по одному действию агента. */
export interface GuardVerdict {
  level: 'safe' | 'ask' | 'block'
  reason: string
  by: 'guard' | 'rules'
}

export type ToolCallStatus = 'pending' | 'checking' | 'awaitingApproval' | 'running' | 'done' | 'error' | 'denied'

export interface ToolCallRecord {
  id: string
  name: ToolName | string
  /** Разобранные аргументы (для показа). */
  args: Record<string, unknown>
  status: ToolCallStatus
  /** Что ушло модели в ответ (усечённо). */
  result?: string
  error?: string
  guard?: GuardVerdict
  approvedBy?: 'auto' | 'user' | 'session'
  /** Для записи/правки файла: unified diff (усечённый) для показа. */
  diff?: string
  exitCode?: number
  durationMs?: number
}

/** Один шаг агента: текст модели и вызовы инструментов, сделанные в этом шаге. */
export interface AgentTurn {
  content: string
  reasoning?: string
  toolCalls: ToolCallRecord[]
}

export interface GuardStatus {
  state: 'off' | 'noModel' | 'idle' | 'starting' | 'ready' | 'error'
  modelId?: string
  error?: string
  /** id загрузки рекомендованной модели-охранника (DownloadItem.id), пока она качается. */
  downloadId?: string
}

export interface MessageVersion {
  content: string
  reasoning?: string
  /** Режим агента: шаги с вызовами инструментов (content — текст последнего шага). */
  turns?: AgentTurn[]
  stats?: GenerationStats
  modelId?: string
  error?: string
  createdAt: number
}

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  versions: MessageVersion[]
  activeVersion: number
  attachments?: Attachment[]
  /** Цитаты RAG, подставленные в этот запрос. */
  citations?: Array<{ attachmentId: string; text: string; score: number }>
}

export interface Conversation {
  id: string
  title: string
  folder: string
  createdAt: number
  updatedAt: number
  messages: ChatMessage[]
  /** Настройки генерации, переопределённые в этом чате. */
  prediction?: Partial<PredictionConfig>
  presetId?: string
  pinned?: boolean
  /** Режим агента в этом чате. cwd — рабочая папка по умолчанию для команд и относительных путей. */
  agent?: { enabled: boolean; cwd: string; allowAll?: boolean }
}

export interface ConversationSummary {
  id: string
  title: string
  folder: string
  updatedAt: number
  messageCount: number
  pinned?: boolean
}

export interface ChatDelta {
  conversationId: string
  messageId: string
  content?: string
  reasoning?: string
  done?: boolean
  stats?: GenerationStats
  error?: string
  /** Режим агента: полный снимок шагов при каждом изменении (новый шаг, статус инструмента). */
  turns?: AgentTurn[]
}

export interface GenerateRequest {
  conversationId: string
  /** Перегенерировать ответ assistant с этим id (новая версия). */
  regenerateMessageId?: string
  /** Продолжить последнее сообщение assistant. */
  continueMessageId?: string
  prediction: PredictionConfig
}

// ---------- Пресеты и настройки ----------

export interface Preset {
  id: string
  name: string
  prediction: Partial<PredictionConfig>
  load?: Partial<LoadConfig>
  createdAt: number
  updatedAt: number
}

export type Guardrails = 'off' | 'relaxed' | 'balanced' | 'strict'

export interface AppSettings {
  modelsDir: string
  theme: 'dark' | 'light' | 'auto'
  fontSize: 'small' | 'default' | 'large'
  guardrails: Guardrails
  defaultEngineGguf: EngineChoice
  defaultLoad: LoadConfig
  defaultPrediction: PredictionConfig
  /** Настройки загрузки, сохранённые для конкретных моделей (⚙ в «Мои модели»). */
  perModelLoad: Record<string, Partial<LoadConfig>>
  expandReasoning: boolean
  lastModelId?: string
  activePresetId?: string
  hasHfToken: boolean
  /** id выбранных рантаймов для движков. */
  selectedRuntimes: Partial<Record<EngineId, string>>
  /** Модель эмбеддингов для RAG (id локальной модели). */
  embeddingModelId?: string
  ragChunkSize: number
  ragChunkOverlap: number
  ragTopK: number
  imageMaxDimension: number
  onboardingDone: boolean
  agent: AgentSettings
}

export type UpdateState =
  | 'idle'
  | 'checking'
  | 'available'
  | 'notAvailable'
  | 'downloading'
  | 'downloaded'
  | 'error'
  | 'unsupported'

export interface UpdateStatus {
  state: UpdateState
  currentVersion: string
  /** Версия доступного обновления. */
  newVersion?: string
  /** Процент загрузки (downloading). */
  percent?: number
  /** Описание релиза (markdown). */
  notes?: string
  error?: string
  /** Portable-сборка сама себя не обновляет: install откроет страницу релизов. */
  manual?: boolean
}

export interface AppInfo {
  version: string
  userDataDir: string
  runtimesDir: string
  logsDir: string
  isPackaged: boolean
}

export type { Place }
