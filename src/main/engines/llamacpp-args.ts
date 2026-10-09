// Чистая функция: аргументы llama-server для llama.cpp (mainline) и ik_llama.cpp.
// Флаги сверены с `llama-server --help` сборок b11538 (mainline) и main-b5418 (ik).
import type { KvCacheType, LoadConfig, MemoryLayout } from '@shared/config'
import type { LocalModel } from '@shared/types'

export type LlamaFlavor = 'mainline' | 'ik'

export interface LlamaArgsInput {
  flavor: LlamaFlavor
  model: LocalModel
  load: LoadConfig
  /** Конкретная раскладка памяти (MemoryPlan.resolved). */
  layout: MemoryLayout
  /** Слоёв (блоков) в модели; 0 — неизвестно. */
  nLayers?: number
  port: number
  /** Потоки по умолчанию, если cpuThreads = 0 (физические ядра). */
  threadsDefault: number
  /** Устройство для -ot (CUDA0/Vulkan0). Не задано — сборка без GPU. */
  gpuDevice?: string
  draftModelPath?: string
  templateFile?: string
}

/** Типы KV-кэша, которые понимает mainline (ik дополнительно знает q6_0 и q8_KV). */
const MAINLINE_KV = new Set(['f32', 'f16', 'bf16', 'q8_0', 'q5_1', 'q5_0', 'q4_1', 'q4_0', 'iq4_nl'])

export function kvTypeFor(flavor: LlamaFlavor, t: KvCacheType): string {
  if (flavor === 'ik' || MAINLINE_KV.has(t)) return t
  // q8_KV / q6_0 есть только в ik — ближайший аналог в mainline.
  return 'q8_0'
}

/** Разбивает строку как командную строку: пробелы, "двойные" и 'одинарные' кавычки, \" внутри. */
export function splitArgs(s: string): string[] {
  const out: string[] = []
  let cur = ''
  let has = false
  let quote: '"' | "'" | null = null
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!
    if (quote) {
      if (c === quote) quote = null
      else if (c === '\\' && quote === '"' && (s[i + 1] === '"' || s[i + 1] === '\\')) cur += s[++i]
      else cur += c
      continue
    }
    if (c === '"' || c === "'") {
      quote = c
      has = true
    } else if (/\s/.test(c)) {
      if (has) out.push(cur)
      cur = ''
      has = false
    } else {
      cur += c
      has = true
    }
  }
  if (has) out.push(cur)
  return out
}

/** Регэксп номеров блоков 0..n-1 (для -ot по «первым N слоям»). */
export function layerRangeRegex(n: number): string {
  return `(?:${Array.from({ length: n }, (_, i) => i).join('|')})`
}

// Шаблоны -ot (std::regex_search, поэтому якоря обязательны: иначе output\.weight
// совпадёт с blk.N.attn_output.weight).
export const OT_OUTPUT = '^output\\.weight$'
/** При связанных эмбеддингах голова — копия token_embd.weight (входная копия и так на CPU). */
export const OT_TIED_OUTPUT = '^token_embd\\.weight$'
/**
 * Смешивание токенов: attention, а у гибридных моделей ещё ssm_* (Mamba, Qwen3-Next) и time_mix_* (RWKV).
 * Без норм: они крошечные, а на CPU рвут граф на пересылки.
 */
export const OT_ATTN = '^blk\\.\\d+\\.(?:attn|ssm|time_mix)_(?!.*norm)'
/** Плотный FFN; не совпадает с ffn_*_exps / ffn_*_shexp (MoE). */
export const otFfn = (layers?: number): string =>
  `^blk\\.${layers === undefined ? '\\d+' : layerRangeRegex(layers)}\\.ffn_(up|down|gate|gate_up)\\.(weight|bias)$`

const num = (n: number): string => String(n)

export function buildLlamaServerArgs(input: LlamaArgsInput): string[] {
  const { flavor, model, load, layout, port } = input
  const ik = flavor === 'ik'
  const nLayers = input.nLayers && input.nLayers > 0 ? input.nLayers : (model.arch?.nLayers ?? 0)
  const a: string[] = []

  a.push('-m', model.path, '--host', '127.0.0.1', '--port', num(port))
  a.push('-c', num(load.contextLength))
  a.push('--jinja')
  a.push(...(ik ? ['--webui', 'none'] : ['--no-webui']))
  a.push('-np', num(Math.max(1, load.maxParallel)))
  if (!ik) {
    // Без -lv 4 mainline не пишет размеры буферов (нужны для MemoryActual).
    a.push('-lv', '4')
    // Размещение считаем сами (memory/planner), автоподбор llama.cpp выключаем.
    a.push('--fit', 'off')
    a.push(load.unifiedKvCache ? '--kv-unified' : '--no-kv-unified')
  }

  a.push('-t', num(load.cpuThreads > 0 ? load.cpuThreads : Math.max(1, input.threadsDefault)))
  a.push('-b', num(load.evalBatchSize), '-ub', num(load.physicalBatchSize))
  if (load.ropeFrequencyBase.enabled) a.push('--rope-freq-base', num(load.ropeFrequencyBase.value))
  if (load.ropeFrequencyScale.enabled) a.push('--rope-freq-scale', num(load.ropeFrequencyScale.value))

  // mmap / mlock: в mainline их заменил --load-mode.
  if (ik) {
    if (load.keepModelInMemory) a.push('--mlock')
    if (!load.tryMmap) a.push('--no-mmap')
  } else if (load.keepModelInMemory) {
    a.push('--load-mode', load.tryMmap ? 'mmap+mlock' : 'mlock')
  } else if (!load.tryMmap) {
    a.push('--load-mode', 'none')
  }

  if (load.seed.enabled) a.push('--seed', num(load.seed.value))
  a.push('-fa', load.flashAttention)
  if (load.kCacheType.enabled) a.push('-ctk', kvTypeFor(flavor, load.kCacheType.value))
  if (load.vCacheType.enabled) a.push('-ctv', kvTypeFor(flavor, load.vCacheType.value))
  if (load.numExperts > 0 && model.arch?.arch) {
    a.push('--override-kv', `${model.arch.arch}.expert_used_count=int:${load.numExperts}`)
  }
  if (load.promptTemplate.enabled && input.templateFile) a.push('--chat-template-file', input.templateFile)

  if (load.speculative.enabled && input.draftModelPath) {
    const s = load.speculative
    a.push('-md', input.draftModelPath)
    if (input.gpuDevice) a.push('-ngld', '999')
    if (ik) {
      a.push('--spec-type', `draft:n_max=${s.draftMax},n_min=${s.draftMin},p_min=${s.pMin}`)
    } else {
      a.push('--spec-type', 'draft-simple')
      a.push('--spec-draft-n-max', num(s.draftMax), '--spec-draft-n-min', num(s.draftMin))
      a.push('--spec-draft-p-min', num(s.pMin))
    }
  }

  if (model.mmprojPath) {
    a.push('--mmproj', model.mmprojPath)
    if (layout.mmproj === 'ram' || !input.gpuDevice) a.push('--no-mmproj-offload')
  }

  a.push(...memoryArgs(input, nLayers))

  if (load.extraArgs.enabled && load.extraArgs.value.trim()) a.push(...splitArgs(load.extraArgs.value))
  return a
}

/** Раскладка памяти → -ngl, -nkvo, -ot, --n-cpu-moe. */
function memoryArgs(input: LlamaArgsInput, nLayers: number): string[] {
  const { flavor, layout } = input
  const gpu = input.gpuDevice
  const a: string[] = []
  if (!gpu) {
    a.push('-ngl', '0')
    return a
  }

  const all = layout.gpuLayers < 0 || (nLayers > 0 && layout.gpuLayers >= nLayers)
  const n = all ? nLayers : Math.max(0, layout.gpuLayers)
  const ot: string[] = []

  // -ngl считается по-разному: mainline первой выгружает выходную голову
  // (ngl = N+1 → N последних блоков + output), ik — сначала блоки (output только при ngl > n_layer).
  // MTP/NextN-слои стоят в конце block_count (arch.nLayers их не включает), но -ngl их считает:
  // чтобы на GPU попали N основных блоков, к N прибавляем nextn.
  const nextn = Math.max(0, input.model.arch?.nextnLayers ?? 0)
  const headToCpu = [`${OT_OUTPUT}=CPU`, `${OT_TIED_OUTPUT}=CPU`]
  if (all) {
    a.push('-ngl', '999')
    if (layout.output === 'ram') ot.push(...headToCpu)
  } else if (flavor === 'mainline') {
    if (n === 0) {
      a.push('-ngl', layout.output === 'ram' ? '0' : '1')
    } else {
      a.push('-ngl', num(n + nextn + 1))
      if (layout.output === 'ram') ot.push(...headToCpu)
    }
  } else {
    a.push('-ngl', num(n > 0 ? n + nextn : 0))
    if (layout.output === 'vram' && n > 0) ot.push(`${OT_OUTPUT}=${gpu}`)
  }

  if (layout.kvCache === 'ram') a.push('-nkvo')
  if (layout.attention === 'ram') ot.push(`${OT_ATTN}=CPU`)

  // ffnCpuLayers: плотный FFN первых N блоков в RAM (-1 — у всех, как ffn = 'ram').
  const ffnCpu = layout.ffnCpuLayers ?? 0
  if (layout.ffn === 'ram' || ffnCpu < 0 || (nLayers > 0 && ffnCpu >= nLayers)) ot.push(`${otFfn()}=CPU`)
  else if (ffnCpu > 0) ot.push(`${otFfn(ffnCpu)}=CPU`)

  for (const rule of ot) a.push('-ot', rule)

  if (layout.expertsCpuLayers < 0) a.push('--cpu-moe')
  else if (layout.expertsCpuLayers > 0) a.push('--n-cpu-moe', num(layout.expertsCpuLayers))
  return a
}
