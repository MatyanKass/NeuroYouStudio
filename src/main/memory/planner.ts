// План памяти: какие части модели лягут в VRAM, какие в RAM, и влезет ли всё.
// Модель размещения повторяет llama.cpp:
//  • -ngl N — на GPU последние N повторяющихся слоёв; token_embd всегда в RAM (get_rows на CPU);
//    выходная голова — по полю output (слой движков выставляет -ngl/-ot соответственно);
//  • KV-кэш слоя живёт на устройстве слоя; --no-kv-offload (kvCache='ram') — весь KV в RAM,
//    attention считается на CPU;
//  • --n-cpu-moe N — эксперты первых N слоёв в RAM; ffnCpuLayers — плотный FFN первых N слоёв в RAM;
//  • буфер вычислений GPU оценивается по резервированию графа llama.cpp (llama-context.cpp:
//    worst-case ubatch, n_outputs = n_ubatch), плюс копии весов из RAM при op-offload (ubatch ≥ 32).
// Сопоставление раскладки с аргументами — в engines/llamacpp-args.ts.

import { DEFAULT_LOAD_CONFIG, DEFAULT_MEMORY_LAYOUT, type EngineId, type KvCacheType, type LoadConfig, type MemoryLayout } from '@shared/config'
import type {
  FitLevel,
  HardwareInfo,
  LocalModel,
  MemoryComponent,
  MemoryComponentId,
  MemoryPlan,
  ModelArchInfo,
  ModelTensorStats
} from '@shared/types'
import {
  isQuantizedKv,
  kvGeometry,
  layerIsSwa,
  layerKvBytes,
  layerKvHeads,
  layerStateBytes,
  type KvGeometry
} from './kv'

export { kvCacheBytes, kvBytesPerToken, kvTypeBytes, exl3CacheBits } from './kv'

const MiB = 1024 * 1024
const GiB = 1024 * MiB

/** CUDA-контекст + cuBLAS + пул временной памяти llama.cpp. */
// Замер на GTX 1660 (CUDA 12.4): ~77 МиБ сверх буферов; на Blackwell/CUDA 13 больше — берём с запасом.
const CUDA_OVERHEAD = 200 * MiB
/** PyTorch + flash-attn у ExLlamaV3/TabbyAPI. */
const EXL3_GPU_OVERHEAD = 600 * MiB
/** Сам процесс сервера в RAM. */
const LLAMA_RAM_OVERHEAD = 300 * MiB
const EXL3_RAM_OVERHEAD = 1536 * MiB
/** Запас RAM для системы. */
const RAM_SAFETY = 1024 * MiB

const LABELS: Record<MemoryComponentId, string> = {
  compute: 'Буферы вычислений (Flash Attention)',
  attn: 'Веса: attention',
  ffn: 'Веса: FFN',
  experts: 'Веса: эксперты MoE',
  output: 'Выходной слой',
  embd: 'Эмбеддинги токенов',
  kv: 'Контекст (KV-кэш)',
  mmproj: 'Vision-проектор',
  other: 'CUDA-контекст и прочее'
}
const ORDER: MemoryComponentId[] = ['compute', 'attn', 'ffn', 'experts', 'output', 'embd', 'kv', 'mmproj', 'other']

export function formatBytes(b: number): string {
  if (b >= GiB) return `${(b / GiB).toFixed(1).replace('.', ',')} ГБ`
  return `${Math.max(0, Math.round(b / MiB))} МБ`
}

// ---------- Контекст расчёта ----------

interface Ctx {
  model: LocalModel
  arch: ModelArchInfo
  stats: ModelTensorStats
  load: LoadConfig
  engine: EngineId
  hasGpu: boolean
  nCtx: number
  nSeq: number
  ubatch: number
  fa: boolean
  kType: KvCacheType
  vType: KvCacheType
  geo: KvGeometry
  mmprojBytes: number
  /** Метаданных нет — всё оценено по размеру файла. */
  approx: boolean
}

type Split = { vram: number; ram: number }

interface Eval {
  comp: Record<MemoryComponentId, Split>
  vram: number
  ram: number
  ngl: number
  /** Веса слоёв/выхода и KV в RAM (для уровня fit). */
  weightsRam: number
  weightsVram: number
  kvRam: number
  kvVram: number
  expertsCpu: number
  ffnCpu: number
  opOffloadCopy: number
}

function makeCtx(model: LocalModel, load: LoadConfig, hw: HardwareInfo, engine: EngineId): Ctx {
  const approx = !model.arch || !model.tensors
  const arch = model.arch ?? syntheticArch(model.sizeBytes, model.isMoe)
  const stats = model.tensors && model.tensors.layers.length === arch.nLayers ? model.tensors : syntheticStats(model.sizeBytes, arch)
  const nCtx = Math.max(256, Math.round(load.contextLength || 4096))
  const nSeq = Math.max(1, load.maxParallel || 1)
  const ubatch = Math.max(1, Math.min(load.physicalBatchSize || 512, load.evalBatchSize || 2048, nCtx))
  const kType = load.kCacheType.enabled ? load.kCacheType.value : 'f16'
  const vType = load.vCacheType.enabled ? load.vCacheType.value : 'f16'
  const hasGpu = hw.gpus.length > 0
  // auto: в CUDA-сборках FA включается почти всегда
  const fa = engine === 'exl3' ? true : load.flashAttention === 'on' || (load.flashAttention === 'auto' && hasGpu)
  const geo = kvGeometry(arch, nCtx, {
    engine,
    nSeq,
    unified: load.unifiedKvCache,
    nUbatch: ubatch
  })
  let mmprojBytes = 0
  if (engine === 'exl3') mmprojBytes = stats.vision ?? 0
  else if (model.mmprojPath) mmprojBytes = model.mmprojSizeBytes ?? Math.round(0.6 * GiB)
  return { model, arch, stats, load, engine, hasGpu, nCtx, nSeq, ubatch, fa, kType, vType, geo, mmprojBytes, approx }
}

/** Архитектура «на глаз» по размеру файла (≈4,8 бит/вес). */
function syntheticArch(sizeBytes: number, isMoe: boolean): ModelArchInfo {
  const p = sizeBytes / 0.6
  const [nLayers, nEmbd] =
    p < 2e9 ? [16, 2048] : p < 5e9 ? [28, 3072] : p < 10e9 ? [32, 4096] : p < 20e9 ? [40, 5120] : p < 40e9 ? [64, 5120] : [80, 8192]
  return {
    arch: 'unknown',
    nLayers,
    nEmbd,
    nHead: nEmbd / 128,
    nHeadKv: 8,
    headDimK: 128,
    headDimV: 128,
    contextLengthMax: 0,
    nExperts: isMoe ? 64 : 0,
    nExpertsUsed: isMoe ? 8 : 0,
    slidingWindow: 0,
    swaLayers: 0,
    mlaKvDim: 0,
    recurrentLayers: 0,
    vocabSize: 128000,
    nFf: nEmbd * 3.5
  }
}

/** Веса по группам «на глаз», когда тензоры не прочитаны. */
function syntheticStats(sizeBytes: number, a: ModelArchInfo): ModelTensorStats {
  const embd = Math.min(0.12 * sizeBytes, a.vocabSize * a.nEmbd * 0.6)
  const rest = Math.max(0, sizeBytes - 2 * embd)
  const per = rest / Math.max(1, a.nLayers)
  const moe = a.nExperts > 1
  const layer = moe
    ? { attn: per * 0.06, ffn: 0, experts: per * 0.9, sharedExperts: per * 0.04, norm: 0 }
    : { attn: per * 0.3, ffn: per * 0.7, experts: 0, sharedExperts: 0, norm: 0 }
  return {
    tokenEmbd: embd,
    output: embd,
    other: 0,
    layers: Array.from({ length: a.nLayers }, () => ({ ...layer })),
    maxTensor: { attn: layer.attn / 2.5, ffn: layer.ffn / 3, experts: layer.experts / 3, sharedExperts: layer.sharedExperts / 3 }
  }
}

const zeroComp = (): Record<MemoryComponentId, Split> => {
  const out = {} as Record<MemoryComponentId, Split>
  for (const id of ORDER) out[id] = { vram: 0, ram: 0 }
  return out
}

// ---------- llama.cpp / ik_llama.cpp ----------

function evaluateLlama(c: Ctx, L: MemoryLayout): Eval {
  const { arch: a, stats: s } = c
  const n = a.nLayers
  const comp = zeroComp()
  const put = (id: MemoryComponentId, gpu: boolean, bytes: number): void => {
    if (bytes <= 0) return
    if (gpu) comp[id].vram += bytes
    else comp[id].ram += bytes
  }

  const gpu = c.hasGpu
  const ngl = !gpu ? 0 : L.gpuLayers < 0 ? n : Math.min(n, Math.max(0, L.gpuLayers))
  const firstGpu = n - ngl
  const ffnCpuN = L.ffn === 'ram' || L.ffnCpuLayers === -1 ? n : Math.min(n, Math.max(0, L.ffnCpuLayers ?? 0))
  const expCpuN = L.expertsCpuLayers < 0 ? n : Math.min(n, L.expertsCpuLayers)
  const attnRam = L.attention === 'ram'
  const kvGpu = gpu && L.kvCache === 'vram'
  const opOffload = gpu && c.ubatch >= 32
  const mt = s.maxTensor ?? { attn: 0, ffn: 0, experts: 0, sharedExperts: 0 }

  let maxCpuTensor = 0
  let maxCpuLayerKv = 0
  let attnGpuCells = 0
  let attnCpuCells = 0
  let anyGpuLayer = false
  for (let il = 0; il < n; il++) {
    const ly = s.layers[il] ?? { attn: 0, ffn: 0, experts: 0, sharedExperts: 0, norm: 0 }
    const onGpu = gpu && il >= firstGpu
    anyGpuLayer ||= onGpu
    const attnG = onGpu && !attnRam
    const ffnG = onGpu && il >= ffnCpuN
    const expG = onGpu && il >= expCpuN
    put('attn', attnG, ly.attn)
    put('attn', onGpu, ly.norm)
    put('ffn', ffnG, ly.ffn)
    put('ffn', onGpu, ly.sharedExperts)
    put('experts', expG, ly.experts)

    if (!attnG && ly.attn > 0) maxCpuTensor = Math.max(maxCpuTensor, mt.attn || ly.attn / 3)
    if (!ffnG && ly.ffn > 0) maxCpuTensor = Math.max(maxCpuTensor, mt.ffn || ly.ffn / 3)
    if (!expG && ly.experts > 0) maxCpuTensor = Math.max(maxCpuTensor, mt.experts || ly.experts / 3)
    if (!onGpu && ly.sharedExperts > 0) maxCpuTensor = Math.max(maxCpuTensor, mt.sharedExperts || ly.sharedExperts / 3)

    const kv = layerKvBytes(a, il, c.geo, c.kType, c.vType, c.engine) + layerStateBytes(a, il, c.nSeq)
    const kvHere = onGpu && kvGpu
    put('kv', kvHere, kv)
    if (layerKvHeads(a, il) > 0) {
      const cells = layerIsSwa(a, il) ? c.geo.cellsSwa : c.geo.cellsFull
      if (kvHere || (!onGpu && opOffload && L.kvCache === 'vram')) attnGpuCells = Math.max(attnGpuCells, cells)
      else attnCpuCells = Math.max(attnCpuCells, cells)
      if (!onGpu && opOffload && L.kvCache === 'vram') maxCpuLayerKv = Math.max(maxCpuLayerKv, kv)
    }
  }

  // Входные эмбеддинги — всегда RAM. Выход: при tied и выходе на CPU копия не нужна (mmap).
  put('embd', false, s.tokenEmbd)
  // ik_llama.cpp при частичной выгрузке не переносит «связанный» выходной слой на GPU (замер).
  const outGpu = gpu && L.output === 'vram' && !(c.engine === 'ikllama' && s.tiedOutput && ngl < n)
  if (s.tiedOutput && !outGpu) put('output', false, s.other)
  else put('output', outGpu, s.output + s.other)
  const outputWeightCpu = outGpu ? 0 : s.tiedOutput ? s.tokenEmbd : s.output

  // Vision-проектор и его буфер
  if (c.mmprojBytes > 0) {
    const g = gpu && L.mmproj === 'vram'
    put('mmproj', g, c.mmprojBytes + visionCompute(c.mmprojBytes))
  }

  // Буферы вычислений
  const cb = computeBuffersLlama(c, {
    gpu,
    attnGpuCells,
    attnCpuCells,
    outGpu,
    opOffload,
    outputWeightCpu,
    maxCpuTensor,
    maxCpuLayerKv,
    anyGpuLayer
  })
  put('compute', true, cb.gpu)
  put('compute', false, cb.cpu)

  // Прочее
  if (gpu) {
    let pool = 0
    if (c.fa && kvGpu && (isQuantizedKv(c.kType) || isQuantizedKv(c.vType))) {
      // CUDA FA при квантованном KV распаковывает K/V слоя во временный f16-буфер
      const row = Math.max(...Array.from({ length: n }, (_, il) => layerKvHeads(a, il))) * Math.max(a.headDimK, a.headDimV)
      pool = 2 * c.geo.cellsFull * row * 2
    }
    put('other', true, CUDA_OVERHEAD + pool)
  }
  put('other', false, LLAMA_RAM_OVERHEAD)

  return finish(comp, ngl, expCpuN, ffnCpuN, opOffload ? Math.max(maxCpuTensor, outputWeightCpu) : 0)
}

interface ComputeIn {
  gpu: boolean
  attnGpuCells: number
  attnCpuCells: number
  outGpu: boolean
  opOffload: boolean
  outputWeightCpu: number
  maxCpuTensor: number
  maxCpuLayerKv: number
  anyGpuLayer: boolean
}

/**
 * Оценка буферов вычислений по резервированию графа llama.cpp.
 * Калибровка: Llama-3-8B, ctx 8192, ub 512 — FA вкл.: GPU ≈258 МиБ (логиты 128256×512×4 + активации),
 * CPU ≈24 МиБ; FA выкл.: GPU ≈560 МиБ (KQ = n_ctx×ub×n_head×4 доминирует).
 */
function computeBuffersLlama(c: Ctx, x: ComputeIn): { gpu: number; cpu: number } {
  const a = c.arch
  const T = c.ubatch
  const f32 = 4
  const act = T * a.nEmbd * f32
  const swaAny = a.slidingWindow > 0 && a.swaLayers > 0
  const maskCells = c.geo.cellsFull + (swaAny ? c.geo.cellsSwa : 0)
  const mask = maskCells * T * (c.fa ? 2 : 4)
  const hd = Math.max(a.headDimK, a.mlaKvDim > 0 ? a.mlaKvDim : 0)
  const qkv = T * (a.nHead * hd + 2 * Math.max(1, a.nHeadKv) * a.headDimK) * f32
  const attnPeak = (cells: number): number => (c.fa ? 0 : a.nHead * T * cells * f32) + 3 * act + qkv
  // mainline резервирует граф с логитами только для выходных токенов (по одному на запрос),
  // ik_llama.cpp — на весь микропакет (замер: Qwen3-0.6B, ub 512 — 30 против 300 МиБ).
  const logitRows = c.engine === 'llamacpp' ? c.nSeq : T
  const logits = c.model.isEmbedding ? act : a.vocabSize * logitRows * f32 + act
  const nFf = a.nFf && a.nFf > 0 ? a.nFf : 4 * a.nEmbd
  const ffnPeak = T * nFf * f32 * 2 + 2 * act
  const ffe = a.nFfExp && a.nFfExp > 0 ? a.nFfExp : nFf
  const moePeak = a.nExperts > 1 ? T * Math.max(1, a.nExpertsUsed) * (2 * ffe + a.nEmbd) * f32 + 2 * act : 0
  const mlpPeak = Math.max(ffnPeak, moePeak)

  // CPU: входы графа (get_rows эмбеддингов, маски) + то, что считается на CPU
  let cpu = 2 * act + mask + MiB
  if (x.attnCpuCells > 0) cpu = Math.max(cpu, attnPeak(x.attnCpuCells) + mask + act)
  if (!x.gpu) cpu = Math.max(cpu, logits + mask, mlpPeak + mask)

  if (!x.gpu) return { gpu: 0, cpu: Math.round(cpu) }

  const gAttn = x.attnGpuCells > 0 ? attnPeak(x.attnGpuCells) + mask + x.maxCpuLayerKv : 0
  const gLogits = x.outGpu || x.opOffload ? logits + (x.outGpu ? 0 : x.outputWeightCpu) : 0
  const gMlp = x.anyGpuLayer || x.opOffload ? mlpPeak + (x.opOffload ? x.maxCpuTensor : 0) : 0
  const gpu = Math.max(gAttn, gLogits, gMlp)
  if (!x.outGpu && !x.opOffload) cpu = Math.max(cpu, logits)
  return { gpu: Math.round(gpu), cpu: Math.round(cpu) }
}

/** Буфер vision-энкодера (clip): скромная оценка от размера проектора. */
const visionCompute = (mmprojBytes: number): number => Math.min(GiB, 128 * MiB + 0.25 * mmprojBytes)

function finish(
  comp: Record<MemoryComponentId, Split>,
  ngl: number,
  expertsCpu: number,
  ffnCpu: number,
  opOffloadCopy: number
): Eval {
  let vram = 0
  let ram = 0
  for (const id of ORDER) {
    comp[id].vram = Math.round(comp[id].vram)
    comp[id].ram = Math.round(comp[id].ram)
    vram += comp[id].vram
    ram += comp[id].ram
  }
  const w = (['attn', 'ffn', 'experts', 'output'] as const).map((id) => comp[id])
  return {
    comp,
    vram,
    ram,
    ngl,
    weightsRam: w.reduce((s, x) => s + x.ram, 0),
    weightsVram: w.reduce((s, x) => s + x.vram, 0),
    kvRam: comp.kv.ram,
    kvVram: comp.kv.vram,
    expertsCpu,
    ffnCpu,
    opOffloadCopy
  }
}

// ---------- ExLlamaV3 ----------

function evaluateExl3(c: Ctx, L: MemoryLayout): Eval {
  const { arch: a, stats: s } = c
  const n = a.nLayers
  const comp = zeroComp()
  const put = (id: MemoryComponentId, gpu: boolean, bytes: number): void => {
    if (bytes <= 0) return
    if (gpu) comp[id].vram += bytes
    else comp[id].ram += bytes
  }
  const expCpuN = L.expertsCpuLayers < 0 ? n : Math.min(n, L.expertsCpuLayers)
  for (let il = 0; il < n; il++) {
    const ly = s.layers[il] ?? { attn: 0, ffn: 0, experts: 0, sharedExperts: 0, norm: 0 }
    put('attn', true, ly.attn + ly.norm)
    put('ffn', true, ly.ffn + ly.sharedExperts)
    put('experts', il >= expCpuN, ly.experts)
    put('kv', true, layerKvBytes(a, il, c.geo, c.kType, c.vType, 'exl3') + layerStateBytes(a, il, c.nSeq))
  }
  put('embd', false, s.tokenEmbd)
  put('output', true, s.output + Math.max(0, s.other - (s.vision ?? 0)))
  if (c.mmprojBytes > 0) put('mmproj', L.mmproj === 'vram', c.mmprojBytes + visionCompute(c.mmprojBytes))

  // Рабочая память на чанк префилла (chunk_size TabbyAPI ≈ evalBatchSize)
  const chunk = Math.max(256, Math.min(c.load.evalBatchSize || 2048, 8192))
  const ff = Math.max(a.nFf ?? 4 * a.nEmbd, (a.nFfExp ?? 0) * Math.max(1, a.nExpertsUsed))
  const work = chunk * (ff * 2 * 3 + a.nEmbd * 2 * 6 + a.nHead * a.headDimK * 2 * 2) + a.vocabSize * 4 * 2 + 128 * MiB
  put('compute', true, work)
  put('other', true, EXL3_GPU_OVERHEAD)
  put('other', false, EXL3_RAM_OVERHEAD)
  return finish(comp, n, expCpuN, 0, 0)
}

const evaluate = (c: Ctx, L: MemoryLayout): Eval => (c.engine === 'exl3' ? evaluateExl3(c, L) : evaluateLlama(c, L))

// ---------- Автоподбор ----------

function vramBudget(hw: HardwareInfo, L: MemoryLayout): number {
  const avail = vramAvailable(hw, L)
  if (L.profile === 'saveVram') return Math.min(avail, 0.5 * (hw.gpus[0]?.vramTotalMiB ?? 0) * MiB)
  return avail
}

const vramAvailable = (hw: HardwareInfo, L: MemoryLayout): number =>
  Math.max(0, ((hw.gpus[0]?.vramFreeMiB ?? 0) - L.vramReserveMiB) * MiB)

const ramAvailable = (hw: HardwareInfo): number => Math.max(0, hw.ramFreeMiB * MiB - RAM_SAFETY)

function resolveAuto(c: Ctx, hw: HardwareInfo, base: MemoryLayout): MemoryLayout {
  const L = resolveWithBudget(c, base, vramBudget(hw, base))
  // «Экономия VRAM» не должна приводить к нехватке RAM: тогда берём всю доступную VRAM
  if (base.profile === 'saveVram' && c.hasGpu && evaluate(c, L).ram > ramAvailable(hw)) {
    return resolveWithBudget(c, base, vramAvailable(hw, base))
  }
  return L
}

function resolveWithBudget(c: Ctx, base: MemoryLayout, budget: number): MemoryLayout {
  const n = c.arch.nLayers
  const hasMmproj = c.mmprojBytes > 0
  const L: MemoryLayout = {
    ...base,
    gpuLayers: -1,
    attention: 'vram',
    ffn: 'vram',
    ffnCpuLayers: 0,
    expertsCpuLayers: 0,
    output: 'vram',
    kvCache: 'vram',
    mmproj: hasMmproj ? 'vram' : base.mmproj
  }
  if (!c.hasGpu) {
    return c.engine === 'exl3' ? L : { ...L, gpuLayers: 0, kvCache: 'ram', output: 'ram', mmproj: 'ram' }
  }
  if (c.engine !== 'exl3' && base.profile === 'userSplit') L.kvCache = 'ram'

  const fits = (): boolean => evaluate(c, L).vram <= budget
  if (fits()) return L

  const isMoe = c.arch.nExperts > 1 && c.stats.layers.some((l) => l.experts > 0)
  // Плотный FFN, который имеет смысл выносить (у MoE-слоёв в ffn только крошечный роутер)
  const hasDense = c.stats.layers.some((l) => l.ffn > 0.05 * (l.attn + l.ffn + l.experts + l.sharedExperts))

  if (c.engine === 'exl3') {
    // ExLlamaV3 умеет выгружать только экспертов (экспериментально) и vision-башню
    if (isMoe) {
      for (let k = 1; k <= n; k++) {
        L.expertsCpuLayers = k >= n ? -1 : k
        if (fits()) return L
      }
    }
    if (hasMmproj) {
      L.mmproj = 'ram'
      if (fits()) return L
    }
    return L
  }

  if (base.profile === 'longContext' && hasDense) {
    for (let k = 1; k <= n; k++) {
      if (k >= n) {
        L.ffn = 'ram'
        L.ffnCpuLayers = 0
      } else L.ffnCpuLayers = k
      if (fits()) return L
    }
  }
  if (isMoe) {
    for (let k = 1; k <= n; k++) {
      L.expertsCpuLayers = k >= n ? -1 : k
      if (fits()) return L
    }
  }
  if (hasMmproj && L.mmproj === 'vram') {
    L.mmproj = 'ram'
    if (fits()) return L
  }
  for (let g = n - 1; g >= 0; g--) {
    L.gpuLayers = g
    if (fits()) return L
  }
  L.output = 'ram'
  if (fits()) return L
  // Даже без слоёв на GPU не влезает (буферы/контекст) — всё в RAM
  return { ...L, kvCache: 'ram' }
}

// ---------- План ----------

/**
 * Чистая функция: раскладка памяти для модели при данных настройках и железе.
 * В режиме auto вычисляет resolved-раскладку по профилю; в manual — проверяет и считает как есть.
 * Поле args заполняет слой движков (engines/), здесь оно пустое.
 */
export function planMemory(model: LocalModel, load: LoadConfig, hw: HardwareInfo, engine: EngineId): MemoryPlan {
  const c = makeCtx(model, load, hw, engine)
  const layout = load.memory
  const resolved: MemoryLayout =
    layout.mode === 'auto' ? resolveAuto(c, hw, layout) : { ...layout }
  const e = evaluate(c, resolved)
  const n = c.arch.nLayers
  const vramAvail = vramAvailable(hw, resolved)
  const ramAvail = ramAvailable(hw)

  let fit: FitLevel
  if (e.vram > vramAvail || e.ram > ramAvail) fit = 'none'
  else if (engine === 'exl3') fit = e.weightsRam > 0 ? 'partial' : 'full'
  else if (e.weightsRam === 0 && e.kvRam === 0) fit = 'full'
  else if (e.weightsVram === 0 && e.kvVram === 0) fit = 'ram'
  else fit = 'partial'

  const warnings = buildWarnings(c, resolved, e, fit, vramAvail, ramAvail)
  const components = buildComponents(c, resolved, e)

  return {
    engine,
    components,
    vramBytes: e.vram,
    ramBytes: e.ram,
    vramAvailableBytes: vramAvail,
    ramAvailableBytes: ramAvail,
    fit,
    resolved,
    nLayers: n,
    warnings,
    args: []
  }
}

function buildComponents(c: Ctx, L: MemoryLayout, e: Eval): MemoryComponent[] {
  const llama = c.engine !== 'exl3'
  const n = c.arch.nLayers
  const out: MemoryComponent[] = []
  for (const id of ORDER) {
    const s = e.comp[id]
    if (id === 'experts' && !(c.arch.nExperts > 1)) continue
    if (id === 'mmproj' && c.mmprojBytes <= 0) continue
    let movable: boolean
    switch (id) {
      case 'attn':
      case 'ffn':
      case 'output':
      case 'kv':
        movable = llama && c.hasGpu
        break
      case 'experts':
        movable = c.hasGpu && c.arch.nExperts > 1
        break
      case 'mmproj':
        movable = c.hasGpu
        break
      default:
        movable = false
    }
    const comp: MemoryComponent = { id, label: LABELS[id], vramBytes: s.vram, ramBytes: s.ram, movable }
    const hint = componentHint(c, L, e, id, n)
    if (hint) comp.hint = hint
    out.push(comp)
  }
  return out
}

function componentHint(c: Ctx, L: MemoryLayout, e: Eval, id: MemoryComponentId, n: number): string | undefined {
  switch (id) {
    case 'compute': {
      if (c.engine === 'exl3') return 'Рабочая память префилла (chunk) и логиты'
      let h = `Flash Attention ${c.fa ? 'вкл.' : 'выкл.'}, физический батч ${c.ubatch}`
      if (e.opOffloadCopy > 0) h += `; при обработке промпта веса из RAM копируются в VRAM (до ${formatBytes(e.opOffloadCopy)})`
      return h
    }
    case 'attn':
      return c.engine === 'exl3' ? undefined : `Слоёв в VRAM: ${e.ngl} из ${n}${L.attention === 'ram' ? ' (attention принудительно в RAM)' : ''}`
    case 'ffn':
      if (L.ffn === 'ram') return 'Плотный FFN всех слоёв в RAM'
      return e.ffnCpu > 0 ? `Плотный FFN первых ${e.ffnCpu} слоёв в RAM` : undefined
    case 'experts':
      return e.expertsCpu > 0 ? `Эксперты ${e.expertsCpu >= n ? 'всех' : `первых ${e.expertsCpu}`} слоёв в RAM (--n-cpu-moe)` : undefined
    case 'embd':
      return c.engine === 'exl3' ? 'ExLlamaV3 держит эмбеддинги в RAM' : 'Всегда в RAM: входной слой считается на CPU'
    case 'kv': {
      const per = c.arch.mlaKvDim > 0 ? ' (MLA)' : ''
      const swa = c.arch.swaLayers > 0 ? `, SWA-слоёв ${c.arch.swaLayers} по ${c.geo.cellsSwa} ячеек` : ''
      return `${c.geo.cellsFull} ячеек, K ${c.kType} / V ${c.vType}${per}${swa}`
    }
    case 'output':
      return c.stats.tiedOutput ? 'Общие веса с эмбеддингами (tied)' : undefined
    case 'other':
      return c.engine === 'exl3' ? 'PyTorch/CUDA в VRAM, процесс TabbyAPI в RAM' : 'CUDA-контекст, cuBLAS, пул временной памяти; процесс сервера в RAM'
    default:
      return undefined
  }
}

function buildWarnings(c: Ctx, L: MemoryLayout, e: Eval, fit: FitLevel, vramAvail: number, ramAvail: number): string[] {
  const w: string[] = []
  const n = c.arch.nLayers
  if (c.approx) w.push('Метаданные модели не прочитаны — оценка памяти приблизительная.')
  if (!c.hasGpu) {
    w.push(c.engine === 'exl3' ? 'ExLlamaV3 требует видеокарту NVIDIA.' : 'Видеокарта не найдена — модель будет работать на CPU.')
  }

  if (c.engine === 'exl3') {
    if (L.kvCache === 'ram' || L.profile === 'userSplit') {
      w.push('ExLlamaV3 держит KV-кэш только в VRAM — вынести контекст в RAM нельзя.')
    }
    if (e.expertsCpu > 0) w.push('Выгрузка экспертов MoE в RAM в ExLlamaV3 экспериментальная и медленная.')
    if (fit === 'none' && e.vram > vramAvail) {
      w.push(
        `ExLlamaV3 не умеет выгружать плотные веса в RAM: нужно ≈${formatBytes(e.vram)} VRAM, доступно ${formatBytes(vramAvail)}. ` +
          'Выберите квант с меньшим bpw, уменьшите контекст/квантуйте кэш или используйте GGUF.'
      )
    }
  } else {
    if (c.hasGpu && L.kvCache === 'ram' && e.kvRam > 0) {
      w.push('KV-кэш в RAM (--no-kv-offload): attention считается на CPU — на длинном контексте генерация заметно медленнее.')
    }
    if (c.hasGpu && e.ngl < n) w.push(`${n - e.ngl} из ${n} слоёв в RAM — скорость генерации заметно ниже.`)
    if (c.hasGpu && e.expertsCpu > 0) {
      w.push(`Эксперты MoE ${e.expertsCpu >= n ? 'всех' : `${e.expertsCpu} из ${n}`} слоёв в RAM — генерация медленнее, обработка промпта идёт через PCIe.`)
    }
    if ((isQuantizedKv(c.vType) || isQuantizedKv(c.kType)) && !c.fa) {
      if (isQuantizedKv(c.vType)) w.push('Квантованный V-кэш работает только с Flash Attention — включите FA или выберите f16.')
    }
    if (!c.fa && c.nCtx >= 16384 && c.hasGpu) {
      w.push('Без Flash Attention буфер вычислений растёт с контекстом — включите FA для длинного контекста.')
    }
  }

  if (c.arch.contextLengthMax > 0 && c.nCtx > c.arch.contextLengthMax) {
    w.push(`Контекст ${c.nCtx} больше обученного (${c.arch.contextLengthMax}) — без RoPE-масштабирования качество упадёт.`)
  }
  if (fit === 'none') {
    if (e.vram > vramAvail && c.engine !== 'exl3') {
      w.push(`Не хватает VRAM: нужно ${formatBytes(e.vram)}, доступно ${formatBytes(vramAvail)}.`)
    }
    if (e.ram > ramAvail) w.push(`Не хватает RAM: нужно ${formatBytes(e.ram)}, доступно ${formatBytes(ramAvail)}.`)
  }
  return w
}

// ---------- Быстрая оценка для поиска на HF ----------

export interface QuickFit {
  fit: FitLevel
  note: string
  vramBytes: number
  ramBytes: number
}

/**
 * Влезет ли файл модели (размер + архитектура, если известна) при контексте ctx.
 * Без архитектуры — эвристика по размеру. Использует тот же планировщик в авто-режиме «скорость».
 */
export function estimateFitForFile(
  sizeBytes: number,
  arch: ModelArchInfo | undefined,
  hw: HardwareInfo,
  ctx: number,
  opts: { engine?: EngineId; isMoe?: boolean; vramReserveMiB?: number; mmprojBytes?: number } = {}
): QuickFit {
  const engine = opts.engine ?? 'llamacpp'
  const a = arch ?? syntheticArch(sizeBytes, opts.isMoe ?? false)
  const model: LocalModel = {
    id: '',
    format: engine === 'exl3' ? 'exl3' : 'gguf',
    path: '',
    files: [],
    sizeBytes,
    publisher: '',
    repo: '',
    name: '',
    quant: '',
    paramsLabel: '',
    arch: a,
    tensors: syntheticStats(sizeBytes, a),
    isMoe: a.nExperts > 1,
    vision: Boolean(opts.mmprojBytes),
    mmprojPath: opts.mmprojBytes ? 'mmproj' : undefined,
    mmprojSizeBytes: opts.mmprojBytes,
    isEmbedding: false
  }
  const load: LoadConfig = {
    ...DEFAULT_LOAD_CONFIG,
    contextLength: ctx,
    memory: {
      ...DEFAULT_MEMORY_LAYOUT,
      mode: 'auto',
      profile: 'speed',
      vramReserveMiB: opts.vramReserveMiB ?? DEFAULT_MEMORY_LAYOUT.vramReserveMiB
    }
  }
  const p = planMemory(model, load, hw, engine)
  const total = p.vramBytes + p.ramBytes
  let note: string
  switch (p.fit) {
    case 'full':
      note = `Полностью в VRAM: ≈${formatBytes(p.vramBytes)} из ${formatBytes(p.vramAvailableBytes)}`
      break
    case 'partial':
      note = `Частично: ≈${formatBytes(p.vramBytes)} в VRAM, ≈${formatBytes(p.ramBytes)} в RAM — медленнее`
      break
    case 'ram':
      note = `Только в RAM: ≈${formatBytes(p.ramBytes)} — медленно`
      break
    default:
      note =
        engine === 'exl3'
          ? `Не влезет в VRAM: нужно ≈${formatBytes(p.vramBytes)}, доступно ${formatBytes(p.vramAvailableBytes)} (ExLlamaV3 не выгружает веса в RAM)`
          : `Не поместится: нужно ≈${formatBytes(total)}, доступно ${formatBytes(p.vramAvailableBytes + p.ramAvailableBytes)}`
  }
  return { fit: p.fit, note, vramBytes: p.vramBytes, ramBytes: p.ramBytes }
}
