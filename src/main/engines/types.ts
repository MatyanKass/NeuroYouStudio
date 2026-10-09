// Подключаемый слой движков: каждый движок описывается адаптером.
import type { EngineId, LoadConfig, MemoryLayout } from '@shared/config'
import type { LocalModel } from '@shared/types'
import type { LogEvent, LogParser } from './log-parser'

export interface EngineCapabilities {
  /** Управление числом слоёв на GPU (-ngl). */
  gpuLayers: boolean
  /** KV-кэш можно держать в RAM (-nkvo). */
  kvOffloadToggle: boolean
  /** Переопределение размещения тензоров (-ot). */
  tensorOverrides: boolean
  /** Эксперты MoE в RAM (--n-cpu-moe). */
  moeCpu: boolean
  speculative: boolean
  vision: boolean
  /** Типы KV-кэша, которые понимает движок. */
  kvCacheTypes: string[]
}

export interface LaunchInput {
  model: LocalModel
  load: LoadConfig
  /** Конкретная раскладка (MemoryPlan.resolved). */
  layout: MemoryLayout
  /** Слоёв в модели (MemoryPlan.nLayers или arch.nLayers). */
  nLayers: number
  port: number
  runtimeDir: string
  serverExe: string
  /** Потоки по умолчанию (физические ядра). */
  threadsDefault: number
  /** Имя GPU-устройства для -ot (CUDA0, Vulkan0); нет — CPU-сборка. */
  gpuDevice?: string
  draftModelPath?: string
  templateFile?: string
}

export interface LaunchSpec {
  exe: string
  args: string[]
  /** Что показать пользователю вместо args (например, ключи config.yml у TabbyAPI). */
  displayArgs?: string[]
  env: NodeJS.ProcessEnv
  cwd: string
}

export type HealthState = 'ready' | 'loading' | 'down'

export interface EngineAdapter {
  id: EngineId
  title: string
  capabilities: EngineCapabilities
  buildLaunch(input: LaunchInput): LaunchSpec
  createLogParser(): LogParser
  /** Разбор одной строки лога (без состояния — для простых случаев). */
  parseLogLine(line: string): LogEvent[]
  healthcheck(baseUrl: string, signal?: AbortSignal): Promise<HealthState>
}
