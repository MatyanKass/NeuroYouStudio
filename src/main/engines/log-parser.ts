// Разбор лога llama-server (mainline и ik_llama.cpp): буферы по устройствам, этапы загрузки, ошибки.
import type { MemoryActual } from '@shared/types'

export type BufferKind = keyof MemoryActual

export type EngineErrorCode = 'oom' | 'badArg' | 'loadFailed' | 'cuda' | 'port' | 'other'

export type LogEvent =
  | { type: 'buffer'; kind: BufferKind; device: string; mib: number }
  | { type: 'progress'; value: number; stage: string }
  | { type: 'offload'; layers: number; total: number }
  | { type: 'context'; nCtx: number }
  | { type: 'ready' }
  | { type: 'error'; code: EngineErrorCode; message: string; arg?: string }

export interface LogParser {
  feed(line: string): LogEvent[]
  readonly actual: MemoryActual
  readonly ready: boolean
  /** Первая (самая показательная) фатальная ошибка. */
  readonly fatal: Extract<LogEvent, { type: 'error' }> | null
}

export const emptyActual = (): MemoryActual => ({ model: {}, kv: {}, compute: {}, output: {} })

/** Снимает префиксы: «0.00.660.155 I » (mainline) и «INFO [ fn] »/« ERR [ fn] » (ik). */
export function stripPrefix(line: string): string {
  return line
    .replace(/^\d+(?:\.\d+){3}\s+[IWEDT]\s+/, '')
    .replace(/^\s*(?:INFO|WARN|ERR|ERROR|VERB)\s+\[[^\]]*\]\s*/, '')
}

/** CPU_Mapped, CPU_REPACK, CUDA_Host, Vulkan_Host… → CPU (оперативная память). */
export function normalizeDevice(dev: string): string {
  if (/^CPU|Host/i.test(dev)) return 'CPU'
  return dev
}

const BUFFER_RE = /(?:^|\s)([A-Za-z][\w-]*?)\s+(?:(model|KV|RS|compute|output)\s+)?buffer size\s*=\s*([\d.]+)\s*MiB/
const STAGES: Array<[RegExp, number, string]> = [
  [/loading model|llama_model_loader: loaded meta data/, 0.05, 'Чтение модели'],
  [/load_tensors: loading model tensors|llm_load_tensors: ggml ctx size/, 0.1, 'Загрузка весов'],
  [/llama_context: constructing|llama_init_from_model: n_ctx/, 0.8, 'Создание контекста'],
  [/KV buffer size/, 0.85, 'KV-кэш'],
  [/compute buffer size/, 0.9, 'Буферы вычислений'],
  [/warming up the model/, 0.95, 'Прогрев'],
  [/model loaded/, 0.98, 'Модель загружена']
]

export function classifyError(text: string): { code: EngineErrorCode; arg?: string } | null {
  let m: RegExpExecArray | null
  if ((m = /error: (?:invalid|unknown) argument: (\S+)/.exec(text))) return { code: 'badArg', arg: m[1] }
  if ((m = /error: invalid parameter for argument: (\S+)/.exec(text))) return { code: 'badArg', arg: m[1] }
  if ((m = /error while handling argument "([^"]+)"/.exec(text))) return { code: 'badArg', arg: m[1] }
  if (/out of memory|cudaMalloc failed|ErrorOutOfDeviceMemory|failed to allocate (?:\w+ )?buffer|unable to allocate/i.test(text)) {
    return { code: 'oom' }
  }
  if (/couldn't bind|failed to bind|address already in use|Only one usage of each socket address/i.test(text)) {
    return { code: 'port' }
  }
  if (/CUDA error|ggml_cuda_init: failed|no kernel image is available|unsupported toolchain|CUDA driver version is insufficient/i.test(text)) {
    return { code: 'cuda' }
  }
  if (/error loading model|failed to load model|unable to load model|exiting due to model loading error|failed to create context|unknown model architecture/i.test(text)) {
    return { code: 'loadFailed' }
  }
  return null
}

export function createLogParser(): LogParser {
  const actual = emptyActual()
  let ready = false
  let fatal: Extract<LogEvent, { type: 'error' }> | null = null
  let progress = 0

  const feed = (raw: string): LogEvent[] => {
    const line = stripPrefix(raw.replace(/\r$/, ''))
    if (!line.trim()) return []
    const out: LogEvent[] = []

    const b = BUFFER_RE.exec(line)
    if (b) {
      const word = b[2]
      const kind: BufferKind =
        word === 'KV' || word === 'RS'
          ? 'kv'
          : word === 'compute'
            ? 'compute'
            : word === 'output'
              ? 'output'
              : word === 'model' || /load_tensors/.test(line)
                ? 'model'
                : /kv_cache/.test(line)
                  ? 'kv'
                  : 'model'
      const device = normalizeDevice(b[1]!)
      const mib = Number(b[3])
      if (Number.isFinite(mib)) {
        actual[kind][device] = Math.round(((actual[kind][device] ?? 0) + mib) * 100) / 100
        out.push({ type: 'buffer', kind, device, mib })
      }
    }

    const off = /offloaded (\d+)\/(\d+) layers to GPU/.exec(line)
    if (off) out.push({ type: 'offload', layers: Number(off[1]), total: Number(off[2]) })

    const ctx = /(?:llama_context|llama_init_from_model):\s+n_ctx\s+=\s+(\d+)/.exec(line)
    if (ctx) out.push({ type: 'context', nCtx: Number(ctx[1]) })

    for (const [re, value, stage] of STAGES) {
      if (value > progress && re.test(line)) {
        progress = value
        out.push({ type: 'progress', value, stage })
      }
    }

    if (!ready && /listening on http|HTTP server listening|server is listening/.test(line)) {
      ready = true
      out.push({ type: 'ready' })
    }

    const err = classifyError(line)
    if (err) {
      const ev = { type: 'error' as const, code: err.code, message: line.trim(), ...(err.arg ? { arg: err.arg } : {}) }
      // OOM и неверный аргумент важнее следующих за ними «failed to load model».
      if (!fatal || (fatal.code === 'loadFailed' && err.code !== 'loadFailed')) fatal = ev
      out.push(ev)
    }
    return out
  }

  return {
    feed,
    get actual() {
      return actual
    },
    get ready() {
      return ready
    },
    get fatal() {
      return fatal
    }
  }
}

/** Понятная подсказка на русском по коду ошибки. */
export function errorHint(code: EngineErrorCode, arg?: string): string {
  switch (code) {
    case 'oom':
      return 'Не хватило видеопамяти: уменьшите контекст/число слоёв на GPU или включите автоподбор'
    case 'badArg':
      return `Движок не понял аргумент «${arg ?? '?'}» — проверьте «Дополнительные аргументы» или установите другую версию движка`
    case 'loadFailed':
      return 'Не удалось загрузить модель: файл повреждён или не докачан, либо эта версия движка не знает архитектуру модели'
    case 'cuda':
      return 'Ошибка CUDA: обновите драйвер NVIDIA или выберите в разделе «Движки» сборку для CUDA 12'
    case 'port':
      return 'Не удалось занять сетевой порт — повторите загрузку'
    default:
      return 'Движок завершился с ошибкой — подробности в журнале'
  }
}

/** Сумма МиБ по устройству по всем видам буферов. */
export function actualByDevice(actual: MemoryActual): Record<string, number> {
  const out: Record<string, number> = {}
  for (const kind of Object.keys(actual) as BufferKind[]) {
    for (const [dev, mib] of Object.entries(actual[kind])) out[dev] = (out[dev] ?? 0) + mib
  }
  return out
}
