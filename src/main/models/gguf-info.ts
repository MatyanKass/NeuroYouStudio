// Из разобранного GGUF — архитектура (ModelArchInfo), веса по группам (ModelTensorStats)
// и подписи для списка моделей (квант, параметры, тип файла).
// Правила SWA/рекуррентных слоёв повторяют llama.cpp (src/models/*.cpp, llama-hparams.cpp).

import type { ModelArchInfo, ModelTensorStats } from '@shared/types'
import {
  ggmlTypeName,
  ggufShardInfo,
  mdArray,
  mdBool,
  mdNumber,
  mdPerLayer,
  mdString,
  type GgufFile,
  type GgufTensor
} from './gguf'

export interface GgufModelInfo {
  archName: string
  arch?: ModelArchInfo
  tensors: ModelTensorStats
  isMmproj: boolean
  /** mmproj: есть vision-энкодер (а не только аудио). */
  mmprojHasVision: boolean
  isEmbedding: boolean
  isMoe: boolean
  quant: string
  paramsLabel: string
  chatTemplate?: string
  name?: string
  /** Часть размеров тензоров оценена (неизвестные типы). */
  estimatedSizes: boolean
}

// ---------- Архитектура ----------

/** Полностью рекуррентные архитектуры (llm_arch_is_recurrent). */
const RECURRENT_ARCHES = new Set(['mamba', 'mamba2', 'rwkv6', 'rwkv6qwen2', 'rwkv7', 'arwkv7'])

/** Гибриды, где рекуррентный слой = слой с head_count_kv == 0. */
const HYBRID_ZERO_KV = new Set([
  'jamba',
  'granitehybrid',
  'plamo2',
  'lfm2',
  'lfm2moe',
  'kimi-linear',
  'kimi-k3',
  'bailingmoe3',
  'glm5-next'
])

/** Энкодеры эмбеддингов: llama.cpp не создаёт для них KV-кэш. */
const EMBEDDING_ARCHES = new Set([
  'bert',
  'modern-bert',
  'nomic-bert',
  'nomic-bert-moe',
  'neo-bert',
  'jina-bert-v2',
  'jina-bert-v3',
  'eurobert',
  'gemma-embedding',
  'gemma-embedding2',
  't5encoder'
])

interface SwaRule {
  /** Период: в каждом блоке из pattern слоёв один полный (последний, или первый при denseFirst). 0 — все SWA. */
  pattern: number
  denseFirst?: boolean
  /** Окно по умолчанию, если в файле нет sliding_window. */
  window?: number
  /** SWA включается только если в файле есть sliding_window > 0. */
  needWindow?: boolean
}

/** load_swa_pattern(...) из llama.cpp для архитектур без явного массива в метаданных. */
const SWA_RULES: Record<string, SwaRule> = {
  gemma2: { pattern: 2, window: 4096 },
  gemma3: { pattern: 6, needWindow: true },
  gemma3n: { pattern: 5 },
  'gemma-embedding': { pattern: 6 },
  'gemma-embedding2': { pattern: 6 },
  cohere2: { pattern: 4 },
  cohere2moe: { pattern: 4, denseFirst: true },
  olmo2: { pattern: 4, needWindow: true },
  exaone4: { pattern: 4, needWindow: true },
  'exaone-moe': { pattern: 4, window: 128 },
  llama4: { pattern: 4, window: 8192 },
  afmoe: { pattern: 4, needWindow: true },
  'gpt-oss': { pattern: 2 },
  mellum: { pattern: 4, needWindow: true },
  'muse-glimmer': { pattern: 4 },
  plamo3: { pattern: 8, needWindow: true },
  smallthinker: { pattern: 4, denseFirst: true, needWindow: true },
  'modern-bert': { pattern: 3, denseFirst: true, needWindow: true },
  laguna: { pattern: 4, denseFirst: true, needWindow: true }
}

function swaPattern(n: number, pattern: number, denseFirst: boolean): boolean[] {
  const out: boolean[] = []
  for (let il = 0; il < n; il++) {
    out.push(pattern === 0 || (denseFirst ? il % pattern !== 0 : il % pattern < pattern - 1))
  }
  return out
}

const maxOf = (a: readonly number[] | undefined): number => (a && a.length ? Math.max(...a) : 0)

export function ggufArchInfo(g: GgufFile): ModelArchInfo | undefined {
  const md = g.metadata
  const arch = mdString(md, 'general.architecture')
  if (!arch || arch === 'clip') return undefined
  const k = (s: string): string => `${arch}.${s}`
  const nAll = mdNumber(md, k('block_count')) ?? 0
  if (nAll <= 0) return undefined
  const nextn = Math.max(0, Math.min(mdNumber(md, k('nextn_predict_layers')) ?? 0, nAll - 1))
  const n = nAll - nextn

  const nEmbd = mdNumber(md, k('embedding_length')) ?? 0
  const headsAll = mdPerLayer(md, k('attention.head_count'), nAll) ?? new Array<number>(nAll).fill(0)
  const kvAll = mdPerLayer(md, k('attention.head_count_kv'), nAll) ?? headsAll.slice()
  const ffAll = mdPerLayer(md, k('feed_forward_length'), nAll)
  const heads = headsAll.slice(0, n)
  const nHead = maxOf(heads)
  const headDimK = mdNumber(md, k('attention.key_length')) ?? (nHead > 0 ? Math.floor(nEmbd / nHead) : 0)
  const headDimV = mdNumber(md, k('attention.value_length')) ?? (nHead > 0 ? Math.floor(nEmbd / nHead) : 0)
  const headDimKSwa = mdNumber(md, k('attention.key_length_swa'))
  const headDimVSwa = mdNumber(md, k('attention.value_length_swa'))

  // Рекуррентные слои
  let recurrent = new Array<boolean>(n).fill(RECURRENT_ARCHES.has(arch))
  const recArr = mdPerLayer(md, k('attention.recurrent_layers'), nAll)
  const interval = mdNumber(md, k('full_attention_interval'))
  let parallelHybrid = false
  if (recArr) {
    recurrent = recArr.slice(0, n).map((x) => x !== 0)
  } else if (interval && interval > 0) {
    recurrent = recurrent.map((_, i) => (i + 1) % interval !== 0)
  } else if (arch === 'falcon-h1') {
    // У Falcon-H1 в каждом слое и SSM, и attention.
    recurrent.fill(true)
    parallelHybrid = true
  } else if (arch === 'nemotron_h' || arch === 'nemotron_h_moe') {
    recurrent = recurrent.map((_, i) => kvAll[i] === 0 && (ffAll?.[i] ?? 0) === 0)
  } else if (HYBRID_ZERO_KV.has(arch)) {
    recurrent = recurrent.map((_, i) => kvAll[i] === 0)
  }

  // KV-головы по слоям: 0 у рекуррентных и у слоёв с общим KV (Gemma 3n / Gemma 4)
  const layerKvHeads = kvAll.slice(0, n).map((h, i) => (recurrent[i] && !parallelHybrid ? 0 : h))
  let kvFromStart = -1
  const sharedKv = mdNumber(md, k('attention.shared_kv_layers'))
  if (sharedKv !== undefined && sharedKv > 0) kvFromStart = nAll - sharedKv
  else if (arch === 'gemma3n') kvFromStart = 20
  if (kvFromStart >= 0) for (let i = kvFromStart; i < n; i++) layerKvHeads[i] = 0
  if (EMBEDDING_ARCHES.has(arch)) layerKvHeads.fill(0)

  // SWA
  let window = mdNumber(md, k('attention.sliding_window')) ?? 0
  let layerSwa = new Array<boolean>(n).fill(false)
  const swaArr = mdArray(md, k('attention.sliding_window_pattern'))
  const swaPatNum = mdNumber(md, k('attention.sliding_window_pattern'))
  const rule = SWA_RULES[arch]
  if (swaArr?.values) {
    layerSwa = layerSwa.map((_, i) => {
      const v = swaArr.values![i]
      return v === true || (typeof v === 'number' && v !== 0)
    })
  } else if (arch === 'lfm2' || arch === 'lfm2moe') {
    if (window > 0) layerSwa = recurrent.map((r) => !r)
  } else if (rule) {
    if (arch === 'llama4' && md[k('attention.sliding_window')] !== undefined && window === 0) {
      // явный 0 — без chunked attention
    } else if (!rule.needWindow || window > 0) {
      if (window <= 0) window = rule.window ?? 0
      if (window > 0) layerSwa = swaPattern(n, swaPatNum ?? rule.pattern, rule.denseFirst ?? false)
    }
  } else if (swaPatNum !== undefined && window > 0) {
    layerSwa = swaPattern(n, swaPatNum, false)
  }
  if (window <= 0) layerSwa.fill(false)
  layerSwa = layerSwa.map((s, i) => s && layerKvHeads[i]! > 0)

  // MLA (DeepSeek-V2/V3, Kimi K2, GLM-4.7-Lite…): в кэше один сжатый вектор на токен.
  const kvLoraRank = mdNumber(md, k('attention.kv_lora_rank')) ?? 0
  let mlaKvDim = 0
  if (kvLoraRank > 0) {
    const kMla = mdNumber(md, k('attention.key_length_mla'))
    const ropeDim = mdNumber(md, k('rope.dimension_count')) ?? 64
    // Новые GGUF: key_length = kv_lora_rank + rope (576), head_count_kv = 1.
    mlaKvDim = kMla !== undefined ? headDimK * Math.max(1, maxOf(layerKvHeads)) : kvLoraRank + ropeDim
  }

  const recurrentLayers = recurrent.filter(Boolean).length
  const vocabSize =
    mdArray(md, 'tokenizer.ggml.tokens')?.length ??
    mdNumber(md, k('vocab_size')) ??
    g.tensors.find((t) => t.name === 'token_embd.weight')?.dims[1] ??
    0

  const nExperts = mdNumber(md, k('expert_count')) ?? 0
  const nExpertsUsed = maxOf(mdPerLayer(md, k('expert_used_count'), nAll))
  const nFf = maxOf(ffAll?.slice(0, n))
  const nFfExp = maxOf(mdPerLayer(md, k('expert_feed_forward_length'), nAll))

  const info: ModelArchInfo = {
    arch,
    nLayers: n,
    nEmbd,
    nHead,
    nHeadKv: maxOf(layerKvHeads),
    headDimK,
    headDimV,
    contextLengthMax: mdNumber(md, k('context_length')) ?? 0,
    nExperts,
    nExpertsUsed,
    slidingWindow: layerSwa.some(Boolean) ? window : 0,
    swaLayers: layerSwa.filter(Boolean).length,
    mlaKvDim,
    recurrentLayers,
    vocabSize,
    layerKvHeads,
    layerSwa,
    layerRecurrent: recurrent
  }
  if (headDimKSwa !== undefined && headDimKSwa !== headDimK) info.headDimKSwa = headDimKSwa
  if (headDimVSwa !== undefined && headDimVSwa !== headDimV) info.headDimVSwa = headDimVSwa
  if (recurrentLayers > 0) info.recurrentStateElems = recurrentStateElems(md, arch, nEmbd, nHead)
  if (nFf > 0) info.nFf = nFf
  if (nFfExp > 0) info.nFfExp = nFfExp
  if (nextn > 0) info.nextnLayers = nextn
  return info
}

/** Состояние рекуррентного слоя (n_embd_r + n_embd_s из llama-hparams.cpp), элементов. */
function recurrentStateElems(md: GgufFile['metadata'], arch: string, nEmbd: number, nHead: number): number {
  const k = (s: string): number | undefined => mdNumber(md, `${arch}.${s}`)
  const wkv = k('wkv.head_size')
  if (wkv) return (k('token_shift_count') ?? 2) * nEmbd + nEmbd * wkv
  const lCache = k('shortconv.l_cache')
  if (lCache) return nEmbd * Math.max(0, lCache - 1)
  const dConv = k('ssm.conv_kernel') ?? 0
  const kda = k('kda.head_dim')
  if (kda) return 3 * (dConv > 0 ? dConv - 1 : 3) * nHead * kda + kda * kda * nHead
  const dInner = k('ssm.inner_size') ?? 0
  const dState = k('ssm.state_size') ?? 0
  const nGroup = k('ssm.group_count') ?? 0
  return (dConv > 0 ? dConv - 1 : 0) * (dInner + 2 * nGroup * dState) + dState * dInner
}

// ---------- Тензоры ----------

const BLK_RE = /^blk\.(\d+)\.(.+)$/

type Bucket = 'attn' | 'ffn' | 'experts' | 'sharedExperts' | 'norm'

/** Группа тензора внутри блока по имени (без префикса blk.N.). */
export function classifyLayerTensor(rest: string): Bucket {
  if (/norm/.test(rest)) return 'norm'
  if (/_(?:ch)?exps\b|_exps\./.test(rest) || rest.startsWith('exp_probs_b')) return 'experts'
  if (/_shexp\b|_shexp\./.test(rest)) return 'sharedExperts'
  if (rest.startsWith('ffn_') || rest.startsWith('channel_mix_')) return 'ffn'
  return 'attn'
}

export function ggufTensorStats(g: GgufFile, nLayers: number): ModelTensorStats {
  const layers = Array.from({ length: Math.max(0, nLayers) }, () => ({
    attn: 0,
    ffn: 0,
    experts: 0,
    sharedExperts: 0,
    norm: 0
  }))
  const maxTensor = { attn: 0, ffn: 0, experts: 0, sharedExperts: 0 }
  const stats: ModelTensorStats = { tokenEmbd: 0, output: 0, other: 0, layers }
  let mtp = 0
  let hasOutput = false
  let nParams = 0
  let expertElems = 0

  for (const t of g.tensors) {
    const m = BLK_RE.exec(t.name)
    if (m) {
      const il = Number(m[1])
      if (il >= nLayers) {
        mtp += t.size
        continue
      }
      nParams += t.nElements
      const b = classifyLayerTensor(m[2]!)
      layers[il]![b] += t.size
      if (b !== 'norm' && t.size > maxTensor[b]) maxTensor[b] = t.size
      if (b === 'experts') expertElems += t.nElements
      continue
    }
    nParams += t.nElements
    if (isTokenEmbd(t)) stats.tokenEmbd += t.size
    else if (t.name === 'output.weight' || t.name === 'output.bias') {
      stats.output += t.size
      hasOutput = true
    } else stats.other += t.size
  }
  if (!hasOutput && stats.tokenEmbd > 0) {
    // tied embeddings: llama.cpp кладёт копию token_embd на устройство выходного слоя
    stats.output = g.tensors.find((t) => t.name === 'token_embd.weight')?.size ?? stats.tokenEmbd
    stats.tiedOutput = true
  }
  if (mtp > 0) stats.mtp = mtp
  stats.maxTensor = maxTensor
  stats.nParams = nParams
  const nExp = expertCounts(g)
  if (nExp && expertElems > 0) {
    stats.nParamsActive = Math.round(nParams - expertElems + (expertElems * nExp.used) / nExp.total)
  }
  return stats
}

function isTokenEmbd(t: GgufTensor): boolean {
  // per_layer_token_embd (Gemma 3n) — тоже входной get_rows на CPU
  return t.name.startsWith('token_embd.') || t.name.startsWith('per_layer_token_embd.')
}

function expertCounts(g: GgufFile): { total: number; used: number } | undefined {
  const arch = mdString(g.metadata, 'general.architecture')
  if (!arch) return undefined
  const total = mdNumber(g.metadata, `${arch}.expert_count`) ?? 0
  const used = maxOf(mdPerLayer(g.metadata, `${arch}.expert_used_count`, 1))
  return total > 1 && used > 0 ? { total, used } : undefined
}

// ---------- Подписи ----------

const QUANT_RE =
  /(?:^|[-._ ])((?:UD-)?(?:I?Q\d(?:_[A-Z0-9]{1,4}){0,3}|[BF]F16|F16|F32|FP16|FP32|FP8|MXFP4(?:_MOE)?|NVFP4|TQ\d_\d|PQ2_0|PTQ1_0))(?=$|[-._ ])/gi

/** Квант из имени файла: Q4_K_M, UD-Q4_K_XL, IQ4_XS, BF16… (последнее совпадение). */
export function quantFromFileName(fileName: string): string | undefined {
  let name = fileName.replace(/\.gguf$/i, '')
  const shard = ggufShardInfo(fileName)
  if (shard) name = shard.base
  let last: string | undefined
  for (const m of name.matchAll(QUANT_RE)) last = m[1]
  if (!last) return undefined
  const up = last.toUpperCase()
  return up.startsWith('UD-') ? `UD-${up.slice(3)}` : up
}

const FTYPE_LABELS: Record<number, string> = {
  0: 'F32',
  1: 'F16',
  2: 'Q4_0',
  3: 'Q4_1',
  7: 'Q8_0',
  8: 'Q5_0',
  9: 'Q5_1',
  10: 'Q2_K',
  11: 'Q3_K_S',
  12: 'Q3_K_M',
  13: 'Q3_K_L',
  14: 'Q4_K_S',
  15: 'Q4_K_M',
  16: 'Q5_K_S',
  17: 'Q5_K_M',
  18: 'Q6_K',
  19: 'IQ2_XXS',
  20: 'IQ2_XS',
  21: 'Q2_K_S',
  22: 'IQ3_XS',
  23: 'IQ3_XXS',
  24: 'IQ1_S',
  25: 'IQ4_NL',
  26: 'IQ3_S',
  27: 'IQ3_M',
  28: 'IQ2_S',
  29: 'IQ2_M',
  30: 'IQ4_XS',
  31: 'IQ1_M',
  32: 'BF16',
  33: 'Q4_0_4_4',
  34: 'Q4_0_4_8',
  35: 'Q4_0_8_8',
  36: 'TQ1_0',
  37: 'TQ2_0',
  38: 'MXFP4_MOE',
  39: 'NVFP4',
  40: 'Q1_0',
  41: 'Q2_0', // в ik_llama.cpp 41 = Q1_0_G128
  // ik_llama.cpp
  135: 'Q6_0',
  136: 'IQ1_BN',
  137: 'IQ2_BN',
  138: 'IQ2_K',
  139: 'IQ3_K',
  140: 'IQ4_K',
  141: 'IQ5_K',
  142: 'IQ6_K',
  145: 'IQ4_KS',
  146: 'IQ3_KL',
  147: 'IQ2_KS',
  148: 'IQ4_KSS',
  149: 'Q8_KV',
  150: 'IQ5_KS',
  151: 'IQ2_KT',
  152: 'IQ3_KT',
  153: 'IQ4_KT',
  154: 'IQ3_KS',
  155: 'IQ2_KL',
  156: 'IQ1_KT',
  157: 'PQ2_0',
  158: 'PTQ1_0',
  202: 'Q4_0_R8',
  207: 'Q8_0_R8',
  208: 'Q5_0_R4',
  210: 'Q2_K_R4',
  211: 'Q3_K_R4',
  214: 'Q4_K_R4',
  216: 'Q5_K_R4',
  218: 'Q6_K_R4',
  219: 'IQ2_XXS_R4',
  220: 'IQ2_XS_R4',
  223: 'IQ3_XXS_R4',
  224: 'IQ1_S_R4',
  225: 'IQ4_NL_R4',
  226: 'IQ3_S_R4',
  229: 'IQ2_M_R4',
  230: 'IQ4_XS_R8',
  231: 'IQ1_M_R4',
  232: 'BF16_R16',
  335: 'Q6_0_R4',
  337: 'IQ2_BN_R4',
  338: 'IQ2_K_R4',
  339: 'IQ3_K_R4',
  340: 'IQ4_K_R4',
  341: 'IQ5_K_R4',
  345: 'IQ4_KS_R4',
  346: 'IQ4_KS_R16',
  347: 'IQ3_KS_R16',
  350: 'IQ5_KS_R4',
  351: 'MXFP4_R8',
  398: 'Q8_KV_R8',
  399: 'Q8_K_R8'
}

/** general.file_type (llama_ftype) → подпись. */
export function ftypeLabel(ft: number): string | undefined {
  return FTYPE_LABELS[ft & ~1024] // 1024 = LLAMA_FTYPE_GUESSED
}

/** Самый «тяжёлый» тип среди 2D-весов (если нет ни имени, ни file_type). */
function dominantType(g: GgufFile): string | undefined {
  const bytes = new Map<number, number>()
  for (const t of g.tensors) {
    if (t.dims.length < 2) continue
    bytes.set(t.type, (bytes.get(t.type) ?? 0) + t.size)
  }
  let best: number | undefined
  let bestBytes = -1
  for (const [type, b] of bytes) {
    if (b > bestBytes) {
      best = type
      bestBytes = b
    }
  }
  return best === undefined ? undefined : ggmlTypeName(best)
}

/** 7.6B, 30B, 600M… */
export function formatParamCount(n: number): string {
  const fmt = (x: number, unit: string): string => {
    const s = x < 10 ? x.toFixed(1) : String(Math.round(x))
    return `${s.replace(/\.0$/, '')}${unit}`
  }
  if (n >= 1e12) return fmt(n / 1e12, 'T')
  if (n >= 1e9) return fmt(n / 1e9, 'B')
  if (n >= 1e6) return `${Math.round(n / 1e6)}M`
  return `${Math.max(1, Math.round(n / 1e3))}K`
}

export function describeGguf(g: GgufFile, fileName: string): GgufModelInfo {
  const md = g.metadata
  const archName = mdString(md, 'general.architecture') ?? ''
  const name = mdString(md, 'general.name')
  const chatTemplate = mdString(md, 'tokenizer.chat_template')
  const isMmproj = mdString(md, 'general.type') === 'mmproj' || archName === 'clip' || /mmproj/i.test(fileName)
  const mmprojHasVision = mdBool(md, 'clip.has_vision_encoder') ?? !(mdBool(md, 'clip.has_audio_encoder') ?? false)

  const arch = isMmproj ? undefined : ggufArchInfo(g)
  const tensors = ggufTensorStats(g, arch?.nLayers ?? 0)
  const isMoe = (arch?.nExperts ?? 0) > 1

  const pooling = mdNumber(md, `${archName}.pooling_type`) ?? 0
  const hint = `${name ?? ''} ${fileName}`
  const isEmbedding =
    !isMmproj &&
    (EMBEDDING_ARCHES.has(archName) || (pooling > 0 && (!chatTemplate || /embed|rerank/i.test(hint))))

  const ft = mdNumber(md, 'general.file_type')
  const quant =
    quantFromFileName(fileName) ?? (ft !== undefined ? ftypeLabel(ft) : undefined) ?? dominantType(g) ?? ''

  let paramsLabel = mdString(md, 'general.size_label') ?? ''
  if (!paramsLabel && tensors.nParams) {
    paramsLabel = formatParamCount(tensors.nParams)
    if (isMoe && tensors.nParamsActive) paramsLabel += `-A${formatParamCount(tensors.nParamsActive)}`
  }

  return {
    archName,
    arch,
    tensors,
    isMmproj,
    mmprojHasVision,
    isEmbedding,
    isMoe,
    quant,
    paramsLabel,
    chatTemplate,
    name,
    estimatedSizes: g.estimatedSizes
  }
}
