// Адаптер ExLlamaV3 через TabbyAPI: config.yml из настроек загрузки, запуск main.py, разбор лога.
import { writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { stringify } from 'yaml'
import type { KvCacheType, LoadConfig, MemoryLayout } from '@shared/config'
import type { LocalModel } from '@shared/types'
import { tabbyPaths } from '../runtimes/tabby-install'
import { emptyActual, type LogEvent, type LogParser } from './log-parser'
import type { EngineAdapter, HealthState, LaunchInput, LaunchSpec } from './types'

/** Биты квантования KV-кэша ExLlamaV3 (2–8) по типам llama.cpp из настроек. */
function cacheBits(t: KvCacheType): number {
  if (t === 'q8_0' || t === 'q8_KV') return 8
  if (t === 'q6_0') return 6
  if (t === 'q5_0' || t === 'q5_1') return 5
  if (t === 'q4_0' || t === 'q4_1' || t === 'iq4_nl') return 4
  return 16
}

export function tabbyCacheMode(load: LoadConfig): string {
  const k = load.kCacheType.enabled ? cacheBits(load.kCacheType.value) : 16
  const v = load.vCacheType.enabled ? cacheBits(load.vCacheType.value) : 16
  if (k === 16 && v === 16) return 'FP16'
  // Квантуется только одна половина — вторую держим в 8 битах (почти без потерь).
  return `${k === 16 ? 8 : k},${v === 16 ? 8 : v}`
}

export interface TabbyConfigInput {
  model: LocalModel
  load: LoadConfig
  layout: MemoryLayout
  nLayers: number
  port: number
  draftModel?: LocalModel
  templateName?: string
}

/** Конфиг TabbyAPI (config.yml). Чистая функция — для тестов. */
export function buildTabbyConfig(i: TabbyConfigInput): Record<string, unknown> {
  const { model, load, layout } = i
  const ctx = Math.max(256, load.contextLength)
  const model_: Record<string, unknown> = {
    model_dir: dirname(model.path),
    model_name: basename(model.path),
    backend: 'exllamav3',
    max_seq_len: ctx,
    // cache_size должен быть кратен 256 и не меньше max_seq_len (× параллельные запросы).
    cache_size: Math.ceil((ctx * Math.max(1, load.maxParallel)) / 256) * 256,
    cache_mode: tabbyCacheMode(load),
    chunk_size: Math.min(8192, Math.max(256, load.evalBatchSize)),
    max_batch_size: Math.max(1, load.maxParallel),
    gpu_split_auto: true,
    autosplit_reserve: [Math.max(0, Math.round(layout.vramReserveMiB))],
    vision: model.vision,
    vision_offload: model.vision && layout.mmproj === 'ram',
    reasoning: true,
    warmup: false
  }
  if (model.isMoe && layout.expertsCpuLayers !== 0) {
    model_.cpu_moe_offload_layers = layout.expertsCpuLayers < 0 ? i.nLayers : layout.expertsCpuLayers
  }
  if (load.ropeFrequencyScale.enabled && load.ropeFrequencyScale.value > 0) {
    // В TabbyAPI rope_scale — линейное растяжение, обратное freq_scale.
    model_.rope_scale = 1 / load.ropeFrequencyScale.value
  }
  if (i.templateName) model_.prompt_template = i.templateName

  const cfg: Record<string, unknown> = {
    network: {
      host: '127.0.0.1',
      port: i.port,
      disable_auth: true,
      api_servers: ['OAI'],
      send_tracebacks: false
    },
    logging: { log_prompt: false, log_generation_params: false, log_requests: false, log_live_status: false },
    model: model_,
    sampling: { override_preset: 'safe_defaults' },
    developer: { unsafe_launch: false }
  }
  if (load.speculative.enabled && i.draftModel) {
    cfg.draft_model = {
      draft_mode: 'model',
      draft_model_dir: dirname(i.draftModel.path),
      draft_model_name: basename(i.draftModel.path),
      draft_num_tokens: Math.max(1, load.speculative.draftMax),
      draft_cache_mode: tabbyCacheMode(load)
    }
  }
  return cfg
}

/** Журнал TabbyAPI (loguru): этапы загрузки, готовность, ошибки CUDA/памяти. */
export function createTabbyLogParser(): LogParser {
  const actual = emptyActual()
  let ready = false
  let fatal: Extract<LogEvent, { type: 'error' }> | null = null
  const STAGES: Array<[RegExp, number, string]> = [
    [/Loading (?:the )?model|Attempting to load a model/i, 0.1, 'Загрузка весов'],
    [/Loading draft model/i, 0.2, 'Загрузка черновой модели'],
    [/Loading vision/i, 0.6, 'Загрузка vision-модуля'],
    [/Model successfully loaded|Loaded model/i, 0.95, 'Модель загружена'],
    [/Uvicorn running|Application startup complete|Developer documentation/i, 0.99, 'Сервер запущен']
  ]
  return {
    get actual() {
      return actual
    },
    get ready() {
      return ready
    },
    get fatal() {
      return fatal
    },
    feed(line: string): LogEvent[] {
      const out: LogEvent[] = []
      for (const [re, value, stage] of STAGES) {
        if (re.test(line)) out.push({ type: 'progress', value, stage })
      }
      if (/Uvicorn running|Application startup complete/i.test(line)) {
        ready = true
        out.push({ type: 'ready' })
      }
      let err: Extract<LogEvent, { type: 'error' }> | null = null
      if (/OutOfMemoryError|CUDA out of memory|Insufficient VRAM|not enough (?:VRAM|memory)/i.test(line)) {
        err = { type: 'error', code: 'oom', message: line.trim() }
      } else if (/address already in use|Only one usage of each socket address|Port \d+ is (?:already )?in use/i.test(line)) {
        err = { type: 'error', code: 'port', message: line.trim() }
      } else if (/CUDA error|no kernel image is available|CUDA driver version is insufficient/i.test(line)) {
        err = { type: 'error', code: 'cuda', message: line.trim() }
      } else if (/(?:^|\s)(?:ERROR|CRITICAL)\b|Traceback \(most recent call last\)|ModuleNotFoundError|ImportError/.test(line)) {
        err = { type: 'error', code: 'loadFailed', message: line.trim() }
      }
      if (err) {
        // Первая OOM/CUDA-ошибка важнее общих строк Traceback.
        if (!fatal || (fatal.code === 'loadFailed' && err.code !== 'loadFailed')) fatal = err
        out.push(err)
      }
      return out
    }
  }
}

export async function tabbyHealth(baseUrl: string, signal?: AbortSignal): Promise<HealthState> {
  const t = AbortSignal.timeout(3000)
  try {
    const res = await fetch(`${baseUrl}/health`, { signal: signal ? AbortSignal.any([signal, t]) : t })
    await res.body?.cancel().catch(() => undefined)
    if (res.status !== 200) return 'loading'
    // Сервер поднимается после загрузки модели; убедимся, что модель действительно на месте.
    const m = await fetch(`${baseUrl}/v1/model`, { signal: signal ? AbortSignal.any([signal, t]) : t })
    await m.body?.cancel().catch(() => undefined)
    return m.status === 200 ? 'ready' : 'loading'
  } catch {
    return 'down'
  }
}

export interface TabbyLaunchExtras {
  draftModel?: LocalModel
}

export function createTabbyAdapter(extras: () => TabbyLaunchExtras = () => ({})): EngineAdapter {
  return {
    id: 'exl3',
    title: 'ExLlamaV3',
    capabilities: {
      gpuLayers: false,
      kvOffloadToggle: false,
      tensorOverrides: false,
      moeCpu: true,
      speculative: true,
      vision: true,
      kvCacheTypes: ['f16', 'q8_0', 'q6_0', 'q5_0', 'q4_0']
    },
    buildLaunch(input: LaunchInput): LaunchSpec {
      const p = tabbyPaths(input.runtimeDir)
      let templateName: string | undefined
      if (input.load.promptTemplate.enabled && input.load.promptTemplate.value.trim()) {
        templateName = 'neuroyoustudio_custom'
        writeFileSync(join(p.tabbyDir, 'templates', `${templateName}.jinja`), input.load.promptTemplate.value, 'utf8')
      }
      const cfg = buildTabbyConfig({
        model: input.model,
        load: input.load,
        layout: input.layout,
        nLayers: input.nLayers,
        port: input.port,
        draftModel: extras().draftModel,
        templateName
      })
      writeFileSync(join(p.tabbyDir, 'config.yml'), stringify(cfg), 'utf8')
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        PYTHONUTF8: '1',
        PYTHONIOENCODING: 'utf-8',
        PYTHONUNBUFFERED: '1',
        TRITON_CACHE_DIR: join(input.runtimeDir, 'triton-cache'),
        CUDA_CACHE_MAXSIZE: '4294967296',
        VIRTUAL_ENV: p.venvDir,
        PATH: `${join(p.venvDir, 'Scripts')};${process.env.PATH ?? ''}`
      }
      return { exe: p.venvPython, args: ['main.py'], env, cwd: p.tabbyDir }
    },
    createLogParser: createTabbyLogParser,
    parseLogLine: (line) => createTabbyLogParser().feed(line),
    healthcheck: tabbyHealth
  }
}
