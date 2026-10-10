// Настройки загрузки модели и генерации. Набор повторяет LM Studio
// (lmstudio-js schema.ts: llm.load.* / llm.prediction.*), плюс наша раскладка памяти.

export type EngineId = 'llamacpp' | 'ikllama' | 'exl3'
export type EngineChoice = EngineId | 'auto'
export type ModelFormat = 'gguf' | 'exl3'

/** Значение с галочкой «включено» (в LM Studio — checkbox + number). */
export interface Toggle<T> {
  enabled: boolean
  value: T
}

export const KV_CACHE_TYPES = ['f32', 'f16', 'bf16', 'q8_0', 'q5_1', 'q5_0', 'q4_1', 'q4_0', 'iq4_nl'] as const
export type KvCacheType = (typeof KV_CACHE_TYPES)[number] | 'q8_KV' | 'q6_0'

export type Place = 'vram' | 'ram'

export type MemoryProfileId = 'speed' | 'userSplit' | 'longContext' | 'saveVram'

/**
 * Раскладка памяти. В режиме auto из профиля и железа вычисляются конкретные значения
 * (см. memory/planner); в режиме manual берутся поля ниже как есть.
 */
export interface MemoryLayout {
  mode: 'auto' | 'manual'
  profile: MemoryProfileId
  /** Сколько повторяющихся слоёв (блоков) держать в VRAM. -1 = все. */
  gpuLayers: number
  /** Тензоры attention у слоёв в VRAM. 'ram' = принудительно в RAM через -ot. */
  attention: Place
  /** Плотный FFN у слоёв в VRAM. */
  ffn: Place
  /**
   * При ffn = 'vram': у скольких ПЕРВЫХ слоёв плотный FFN (ffn_up/gate/down, без экспертов
   * и общих экспертов) всё же лежит в RAM: -ot `^blk\.(0|…|N-1)\.ffn_(up|down|gate|gate_up)\.(weight|bias)$=CPU`.
   * ffn = 'ram' означает «у всех слоёв». Нет / 0 — ни у одного.
   */
  ffnCpuLayers?: number
  /** MoE: у скольких слоёв эксперты лежат в RAM (--n-cpu-moe). -1 = у всех. */
  expertsCpuLayers: number
  /** Выходная голова (output.weight). */
  output: Place
  /** KV-кэш (контекст). 'ram' = --no-kv-offload. */
  kvCache: Place
  /** Проектор vision-модели (mmproj). */
  mmproj: Place
  /** Сколько VRAM оставлять свободной, МиБ. */
  vramReserveMiB: number
}

export interface SpeculativeConfig {
  enabled: boolean
  draftModelId: string
  draftMax: number
  draftMin: number
  /** Порог вероятности продолжения черновика (--draft-p-min). */
  pMin: number
}

export interface LoadConfig {
  engine: EngineChoice
  contextLength: number
  /** Потоки CPU (пул), -t. 0 = авто. */
  cpuThreads: number
  /** Размер пакета оценки, -b. */
  evalBatchSize: number
  /** Физический размер пакета, -ub. */
  physicalBatchSize: number
  /** Одновременные запросы (--parallel). */
  maxParallel: number
  unifiedKvCache: boolean
  ropeFrequencyBase: Toggle<number>
  ropeFrequencyScale: Toggle<number>
  /** mlock. */
  keepModelInMemory: boolean
  tryMmap: boolean
  seed: Toggle<number>
  flashAttention: 'auto' | 'on' | 'off'
  kCacheType: Toggle<KvCacheType>
  vCacheType: Toggle<KvCacheType>
  /** Число активных экспертов MoE. 0 = как в модели. */
  numExperts: number
  promptTemplate: Toggle<string>
  speculative: SpeculativeConfig
  /** Дополнительные аргументы движка (строка как в командной строке). */
  extraArgs: Toggle<string>
  memory: MemoryLayout
}

export type ContextOverflowPolicy = 'stopAtLimit' | 'truncateMiddle' | 'rollingWindow'

export interface PredictionConfig {
  systemPrompt: string
  temperature: number
  maxTokens: Toggle<number>
  contextOverflow: ContextOverflowPolicy
  stopStrings: string[]
  topK: number
  topP: Toggle<number>
  minP: Toggle<number>
  repeatPenalty: Toggle<number>
  presencePenalty: Toggle<number>
  frequencyPenalty: Toggle<number>
  xtcProbability: Toggle<number>
  xtcThreshold: Toggle<number>
  typicalP: Toggle<number>
  mirostat: { version: 0 | 1 | 2; learningRate: number; targetEntropy: number }
  /** JSON-массив пар [tokenId, bias|"-inf"]. */
  logitBias: string
  seed: Toggle<number>
  structured: { type: 'none' | 'json' | 'gbnf'; jsonSchema: string; gbnf: string }
  reasoning: {
    parsing: boolean
    startString: string
    endString: string
    enableThinking: boolean
    budget: Toggle<number>
  }
}

export const DEFAULT_MEMORY_LAYOUT: MemoryLayout = {
  mode: 'auto',
  profile: 'speed',
  gpuLayers: -1,
  attention: 'vram',
  ffn: 'vram',
  expertsCpuLayers: 0,
  output: 'vram',
  kvCache: 'vram',
  mmproj: 'vram',
  vramReserveMiB: 768
}

export const DEFAULT_LOAD_CONFIG: LoadConfig = {
  engine: 'auto',
  contextLength: 8192,
  cpuThreads: 0,
  evalBatchSize: 2048,
  physicalBatchSize: 512,
  maxParallel: 1,
  unifiedKvCache: true,
  ropeFrequencyBase: { enabled: false, value: 0 },
  ropeFrequencyScale: { enabled: false, value: 0 },
  keepModelInMemory: false,
  tryMmap: true,
  seed: { enabled: false, value: -1 },
  flashAttention: 'on',
  kCacheType: { enabled: false, value: 'f16' },
  vCacheType: { enabled: false, value: 'f16' },
  numExperts: 0,
  promptTemplate: { enabled: false, value: '' },
  speculative: { enabled: false, draftModelId: '', draftMax: 16, draftMin: 0, pMin: 0.75 },
  extraArgs: { enabled: false, value: '' },
  memory: DEFAULT_MEMORY_LAYOUT
}

export const DEFAULT_PREDICTION_CONFIG: PredictionConfig = {
  systemPrompt: '',
  temperature: 0.8,
  maxTokens: { enabled: false, value: 1000 },
  contextOverflow: 'truncateMiddle',
  stopStrings: [],
  topK: 40,
  topP: { enabled: true, value: 0.95 },
  minP: { enabled: true, value: 0.05 },
  repeatPenalty: { enabled: true, value: 1.1 },
  presencePenalty: { enabled: false, value: 0 },
  frequencyPenalty: { enabled: false, value: 0 },
  xtcProbability: { enabled: false, value: 0.5 },
  xtcThreshold: { enabled: false, value: 0.1 },
  typicalP: { enabled: false, value: 0.9 },
  mirostat: { version: 0, learningRate: 0.1, targetEntropy: 5 },
  logitBias: '',
  seed: { enabled: false, value: -1 },
  structured: { type: 'none', jsonSchema: '', gbnf: '' },
  reasoning: {
    parsing: true,
    startString: '<think>',
    endString: '</think>',
    enableThinking: true,
    budget: { enabled: false, value: 1024 }
  }
}

// ---------- Агент (модель с инструментами: файлы и терминал) ----------

/** askDangerous — спрашивать только опасное; askAll — любую запись и команду; auto — без вопросов. */
export type AgentApproval = 'askDangerous' | 'askAll' | 'auto'
export type AgentShell = 'powershell' | 'cmd'

export interface AgentSettings {
  approval: AgentApproval
  /** Модель-охранник оценивает каждую запись файла и команду перед выполнением. */
  guardEnabled: boolean
  /** id локальной модели-охранника ('' — не выбрана). */
  guardModelId: string
  defaultShell: AgentShell
  commandTimeoutSec: number
  /** Максимум шагов (вызовов модели) за один ответ. */
  maxSteps: number
  /** Сколько символов результата инструмента отдавать модели. */
  maxOutputChars: number
}

export const DEFAULT_AGENT_SETTINGS: AgentSettings = {
  approval: 'askDangerous',
  guardEnabled: true,
  guardModelId: '',
  defaultShell: 'powershell',
  commandTimeoutSec: 120,
  maxSteps: 30,
  maxOutputChars: 20000
}

export type DeepPartial<T> = T extends readonly unknown[]
  ? T
  : T extends object
    ? { [K in keyof T]?: DeepPartial<T[K]> }
    : T

/** Глубокое слияние простых объектов (массивы заменяются целиком). */
export function deepMerge<T>(base: T, patch: DeepPartial<NoInfer<T>> | undefined): T {
  if (patch === undefined || patch === null) return base
  if (typeof base !== 'object' || base === null || Array.isArray(base)) return patch as T
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) }
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
    if (v === undefined) continue
    const cur = out[k]
    out[k] =
      cur && typeof cur === 'object' && !Array.isArray(cur) && v && typeof v === 'object' && !Array.isArray(v)
        ? deepMerge(cur, v as DeepPartial<typeof cur>)
        : v
  }
  return out as T
}
