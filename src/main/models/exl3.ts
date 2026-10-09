// Папка модели EXL3 (ExLlamaV3): config.json + *.safetensors.
// Архитектура — из config.json (с учётом text_config у VLM), размеры весов — из заголовков safetensors.

import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import type { ModelArchInfo, ModelTensorStats } from '@shared/types'
import { formatParamCount } from './gguf-info'

type Json = Record<string, unknown>

export interface SafetensorsEntry {
  dtype: string
  shape: number[]
  data_offsets: [number, number]
}

export interface Exl3Info {
  archName: string
  arch?: ModelArchInfo
  tensors: ModelTensorStats
  bpw?: number
  headBits?: number
  vision: boolean
  isMoe: boolean
  quant: string
  paramsLabel: string
  chatTemplate?: string
  name?: string
  sizeBytes: number
  files: string[]
}

const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v)
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)

async function readJsonFile(path: string): Promise<Json | undefined> {
  try {
    const v: unknown = JSON.parse(await fs.readFile(path, 'utf8'))
    return isObj(v) ? v : undefined
  } catch {
    return undefined
  }
}

/** quantization_config из config.json или quantization_config.json, если это EXL3. */
export async function readExl3QuantConfig(dir: string, config?: Json): Promise<Json | undefined> {
  const cfg = config ?? (await readJsonFile(join(dir, 'config.json')))
  const inner = cfg && isObj(cfg.quantization_config) ? cfg.quantization_config : undefined
  const q = inner ?? (await readJsonFile(join(dir, 'quantization_config.json')))
  return q && String(q.quant_method ?? '').toLowerCase() === 'exl3' ? q : undefined
}

/** Папка — модель EXL3? */
export async function isExl3Dir(dir: string): Promise<boolean> {
  try {
    const names = await fs.readdir(dir)
    if (!names.includes('config.json') || !names.some((n) => n.endsWith('.safetensors'))) return false
    return (await readExl3QuantConfig(dir)) !== undefined
  } catch {
    return false
  }
}

/** Заголовок safetensors: 8 байт LE u64 длины + JSON. */
export async function readSafetensorsHeader(path: string): Promise<Record<string, SafetensorsEntry>> {
  const fh = await fs.open(path, 'r')
  try {
    const head = Buffer.alloc(8)
    await fh.read(head, 0, 8, 0)
    const n = Number(head.readBigUInt64LE(0))
    if (!Number.isFinite(n) || n <= 0 || n > 200 * 1024 * 1024) throw new Error(`Повреждённый safetensors: ${path}`)
    const buf = Buffer.alloc(n)
    await fh.read(buf, 0, n, 8)
    const parsed: unknown = JSON.parse(buf.toString('utf8'))
    if (!isObj(parsed)) throw new Error(`Повреждённый safetensors: ${path}`)
    const out: Record<string, SafetensorsEntry> = {}
    for (const [k, v] of Object.entries(parsed)) {
      if (k === '__metadata__' || !isObj(v) || !Array.isArray(v.data_offsets)) continue
      out[k] = v as unknown as SafetensorsEntry
    }
    return out
  } finally {
    await fh.close()
  }
}

// ---------- Архитектура из config.json ----------

/** Текстовая часть конфига (у VLM — text_config / llm_config). */
export function textConfig(config: Json): Json {
  for (const key of ['text_config', 'llm_config', 'language_config', 'thinker_config']) {
    const v = config[key]
    if (isObj(v) && (v.num_hidden_layers !== undefined || v.hidden_size !== undefined)) return v
  }
  return config
}

/** Период SWA по model_type, если нет layer_types (как в transformers). */
const SWA_PATTERN: Record<string, number> = { gemma2: 2, gemma3: 6, gemma3_text: 6, cohere2: 4, gpt_oss: 2 }

export function exl3ArchInfo(config: Json): ModelArchInfo | undefined {
  const c = textConfig(config)
  const n = num(c.num_hidden_layers) ?? num(c.n_layer) ?? num(c.num_layers) ?? 0
  if (n <= 0) return undefined
  const nEmbd = num(c.hidden_size) ?? num(c.d_model) ?? 0
  const nHead = num(c.num_attention_heads) ?? 0
  const nHeadKv = num(c.num_key_value_heads) ?? nHead
  const headDim = num(c.head_dim) ?? (nHead > 0 ? Math.floor(nEmbd / nHead) : 0)
  const modelType = String(c.model_type ?? config.model_type ?? '')
  const window = num(c.sliding_window) ?? 0

  const types = Array.isArray(c.layer_types) ? c.layer_types.map((t) => String(t)) : undefined
  const layerRecurrent = new Array<boolean>(n).fill(false)
  let layerSwa = new Array<boolean>(n).fill(false)
  if (types) {
    for (let i = 0; i < n; i++) {
      const t = types[i] ?? ''
      layerSwa[i] = /sliding|chunked|local/.test(t)
      layerRecurrent[i] = /linear|mamba|conv|recurrent|ssm|delta/.test(t)
    }
  } else {
    const interval = num(c.full_attention_interval)
    if (interval && interval > 0) for (let i = 0; i < n; i++) layerRecurrent[i] = (i + 1) % interval !== 0
    const pat = num(c.sliding_window_pattern) ?? SWA_PATTERN[modelType]
    if (window > 0 && pat) for (let i = 0; i < n; i++) layerSwa[i] = i % pat < pat - 1
  }
  if (window <= 0) layerSwa = layerSwa.map(() => false)
  const layerKvHeads = layerRecurrent.map((r) => (r ? 0 : nHeadKv))
  layerSwa = layerSwa.map((s, i) => s && !layerRecurrent[i])

  const nExperts = num(c.num_local_experts) ?? num(c.num_experts) ?? num(c.n_routed_experts) ?? 0
  const info: ModelArchInfo = {
    arch: modelType || String((Array.isArray(config.architectures) && config.architectures[0]) ?? 'unknown'),
    nLayers: n,
    nEmbd,
    nHead,
    nHeadKv,
    headDimK: headDim,
    headDimV: num(c.v_head_dim) ?? headDim,
    contextLengthMax: num(c.max_position_embeddings) ?? 0,
    nExperts,
    nExpertsUsed: num(c.num_experts_per_tok) ?? num(c.moe_topk) ?? 0,
    slidingWindow: layerSwa.some(Boolean) ? window : 0,
    swaLayers: layerSwa.filter(Boolean).length,
    mlaKvDim: 0,
    recurrentLayers: layerRecurrent.filter(Boolean).length,
    vocabSize: num(c.vocab_size) ?? num(config.vocab_size) ?? 0,
    layerKvHeads,
    layerSwa,
    layerRecurrent
  }
  const nFf = num(c.intermediate_size)
  const nFfExp = num(c.moe_intermediate_size)
  if (nFf) info.nFf = nFf
  if (nFfExp) info.nFfExp = nFfExp
  // Состояние линейного attention (Qwen3-Next: Gated DeltaNet)
  if (info.recurrentLayers > 0) {
    const kHeads = num(c.linear_num_key_heads) ?? 0
    const vHeads = num(c.linear_num_value_heads) ?? 0
    const kDim = num(c.linear_key_head_dim) ?? 0
    const vDim = num(c.linear_value_head_dim) ?? 0
    const conv = num(c.linear_conv_kernel_dim) ?? 4
    if (vHeads && vDim) {
      info.recurrentStateElems = (conv - 1) * (2 * kHeads * kDim + vHeads * vDim) + vHeads * kDim * vDim
    }
  }
  return info
}

/** Грубая оценка числа параметров по конфигу (если имя ничего не говорит). */
export function approxParams(config: Json): { total: number; active: number } | undefined {
  const a = exl3ArchInfo(config)
  if (!a) return undefined
  const c = textConfig(config)
  const attn = a.nEmbd * a.nHead * a.headDimK * 2 + a.nEmbd * a.nHeadKv * a.headDimK * 2
  const nFf = a.nFf ?? 0
  const dense = 3 * a.nEmbd * nFf
  const tied = c.tie_word_embeddings === true || config.tie_word_embeddings === true
  const embed = a.vocabSize * a.nEmbd * (tied ? 1 : 2)
  if (a.nExperts > 1) {
    const ffe = a.nFfExp ?? nFf
    const experts = a.nExperts * 3 * a.nEmbd * ffe
    const shared = num(c.shared_expert_intermediate_size) ?? 0
    const perLayer = attn + experts + 3 * a.nEmbd * shared
    const activePerLayer = attn + a.nExpertsUsed * 3 * a.nEmbd * ffe + 3 * a.nEmbd * shared
    return { total: a.nLayers * perLayer + embed, active: a.nLayers * activePerLayer + embed }
  }
  const total = a.nLayers * (attn + dense) + embed
  return { total, active: total }
}

/** «8B», «30B-A3B» из имени репозитория. */
export function paramsLabelFromName(name: string): string | undefined {
  const m = /(?:^|[-_.\s])(\d+(?:\.\d+)?)[bB](?:-A(\d+(?:\.\d+)?)[bB])?(?=$|[-_.\s])/.exec(name)
  if (m) return m[2] ? `${m[1]}B-A${m[2]}B` : `${m[1]}B`
  const x = /(?:^|[-_.\s])(\d+x\d+(?:\.\d+)?)[bB](?=$|[-_.\s])/.exec(name)
  if (x) return `${x[1]}B`
  const mm = /(?:^|[-_.\s])(\d+)[mM](?=$|[-_.\s])/.exec(name)
  return mm ? `${mm[1]}M` : undefined
}

// ---------- Тензоры ----------

const VISION_RE = /(?:^|\.)(?:vision_tower|vision_model|visual|vision_encoder|vision_embed|multi_modal_projector|mm_projector|image_newline|audio_tower|embed_vision)(?:\.|$)/
const LAYER_RE = /(?:^|\.)layers\.(\d+)\.(.+)$/

export type Exl3Bucket =
  | { kind: 'layer'; layer: number; bucket: 'attn' | 'ffn' | 'experts' | 'sharedExperts' | 'norm' }
  | { kind: 'tokenEmbd' | 'output' | 'vision' | 'other' }

export function classifyExl3Tensor(name: string): Exl3Bucket {
  if (VISION_RE.test(name)) return { kind: 'vision' }
  const m = LAYER_RE.exec(name)
  if (m) {
    const layer = Number(m[1])
    const rest = m[2]!
    if (/norm/.test(rest)) return { kind: 'layer', layer, bucket: 'norm' }
    if (/shared_expert/.test(rest)) return { kind: 'layer', layer, bucket: 'sharedExperts' }
    if (/(?:^|\.)experts\./.test(rest)) return { kind: 'layer', layer, bucket: 'experts' }
    if (/^(?:mlp|block_sparse_moe|feed_forward|moe)\./.test(rest)) return { kind: 'layer', layer, bucket: 'ffn' }
    return { kind: 'layer', layer, bucket: 'attn' }
  }
  if (/embed_tokens/.test(name)) return { kind: 'tokenEmbd' }
  if (/(?:^|\.)lm_head\./.test(name)) return { kind: 'output' }
  return { kind: 'other' }
}

export function exl3TensorStats(
  entries: Iterable<[string, SafetensorsEntry]>,
  nLayers: number
): { stats: ModelTensorStats; hasVision: boolean } {
  const layers = Array.from({ length: Math.max(0, nLayers) }, () => ({
    attn: 0,
    ffn: 0,
    experts: 0,
    sharedExperts: 0,
    norm: 0
  }))
  const stats: ModelTensorStats = { tokenEmbd: 0, output: 0, other: 0, layers }
  const maxTensor = { attn: 0, ffn: 0, experts: 0, sharedExperts: 0 }
  let vision = 0
  let hasOutput = false
  for (const [name, e] of entries) {
    const size = Math.max(0, (e.data_offsets[1] ?? 0) - (e.data_offsets[0] ?? 0))
    const c = classifyExl3Tensor(name)
    if (c.kind === 'layer') {
      const l = layers[c.layer]
      if (!l) {
        stats.other += size
        continue
      }
      l[c.bucket] += size
      if (c.bucket !== 'norm' && size > maxTensor[c.bucket]) maxTensor[c.bucket] = size
    } else if (c.kind === 'tokenEmbd') stats.tokenEmbd += size
    else if (c.kind === 'output') {
      stats.output += size
      hasOutput = true
    } else if (c.kind === 'vision') {
      vision += size
      stats.other += size
    } else stats.other += size
  }
  if (!hasOutput && stats.tokenEmbd > 0) {
    stats.output = stats.tokenEmbd
    stats.tiedOutput = true
  }
  if (vision > 0) stats.vision = vision
  stats.maxTensor = maxTensor
  return { stats, hasVision: vision > 0 }
}

// ---------- Чтение папки ----------

async function readChatTemplate(dir: string): Promise<string | undefined> {
  try {
    return await fs.readFile(join(dir, 'chat_template.jinja'), 'utf8')
  } catch {
    // нет отдельного файла
  }
  const ctj = await readJsonFile(join(dir, 'chat_template.json'))
  if (ctj && typeof ctj.chat_template === 'string') return ctj.chat_template
  const tc = await readJsonFile(join(dir, 'tokenizer_config.json'))
  const t = tc?.chat_template
  if (typeof t === 'string') return t
  if (Array.isArray(t)) {
    const items = t.filter(isObj)
    const def = items.find((x) => x.name === 'default') ?? items[0]
    if (def && typeof def.template === 'string') return def.template
  }
  return undefined
}

export function formatBpw(bits: number): string {
  return `${Number.isInteger(bits) ? bits.toFixed(1) : String(Number(bits.toFixed(2)))}bpw`
}

export async function readExl3Model(dir: string, displayName = ''): Promise<Exl3Info> {
  const config = await readJsonFile(join(dir, 'config.json'))
  if (!config) throw new Error('Нет config.json или он повреждён')
  const q = await readExl3QuantConfig(dir, config)
  if (!q) throw new Error('Это не модель EXL3 (quant_method ≠ exl3)')

  const names = (await fs.readdir(dir)).sort()
  const files: string[] = []
  let sizeBytes = 0
  const tensors: Array<[string, SafetensorsEntry]> = []
  for (const nm of names) {
    const p = join(dir, nm)
    const st = await fs.stat(p).catch(() => undefined)
    if (!st?.isFile()) continue
    files.push(p)
    sizeBytes += st.size
    if (nm.endsWith('.safetensors')) {
      for (const e of Object.entries(await readSafetensorsHeader(p))) tensors.push(e)
    }
  }

  const arch = exl3ArchInfo(config)
  const { stats, hasVision } = exl3TensorStats(tensors, arch?.nLayers ?? 0)
  const bpw = num(q.bits)
  const headBits = num(q.head_bits)
  const isMoe = (arch?.nExperts ?? 0) > 1
  const vision = hasVision || isObj(config.vision_config)

  let paramsLabel = paramsLabelFromName(displayName) ?? ''
  if (!paramsLabel) {
    const p = approxParams(config)
    if (p) paramsLabel = isMoe ? `${formatParamCount(p.total)}-A${formatParamCount(p.active)}` : formatParamCount(p.total)
  }

  return {
    archName: arch?.arch ?? '',
    arch,
    tensors: stats,
    bpw,
    headBits,
    vision,
    isMoe,
    quant: bpw !== undefined ? formatBpw(bpw) : 'EXL3',
    paramsLabel,
    chatTemplate: await readChatTemplate(dir),
    name: typeof config._name_or_path === 'string' ? config._name_or_path : undefined,
    sizeBytes,
    files
  }
}
