// Размер KV-кэша и рекуррентного состояния — как их выделяет llama.cpp
// (llama-kv-cache.cpp, llama-kv-cache-iswa.cpp, llama-memory-recurrent.cpp) и ExLlamaV3.

import type { EngineId, KvCacheType } from '@shared/config'
import type { ModelArchInfo } from '@shared/types'

/** Байт на элемент кэша. q8_KV (ik_llama.cpp) — 1 байт + 8 байт служебных на строку. */
export function kvTypeBytes(t: KvCacheType, rowLen = 128): number {
  switch (t) {
    case 'f32':
      return 4
    case 'f16':
    case 'bf16':
      return 2
    case 'q8_0':
      return 34 / 32
    case 'q6_0':
      return 26 / 32
    case 'q5_1':
      return 24 / 32
    case 'q5_0':
      return 22 / 32
    case 'q4_1':
      return 20 / 32
    case 'q4_0':
    case 'iq4_nl':
      return 18 / 32
    case 'q8_KV':
      return 1 + 8 / Math.max(1, rowLen)
    default:
      return 2
  }
}

export const isQuantizedKv = (t: KvCacheType): boolean => t !== 'f32' && t !== 'f16' && t !== 'bf16'

/** Биты кэша ExLlamaV3 (2–8, 16 = FP16) по типу из настроек. */
export function exl3CacheBits(t: KvCacheType): number {
  switch (t) {
    case 'q8_0':
    case 'q8_KV':
      return 8
    case 'q6_0':
      return 6
    case 'q5_0':
    case 'q5_1':
      return 5
    case 'q4_0':
    case 'q4_1':
    case 'iq4_nl':
      return 4
    default:
      return 16
  }
}

/** Байт на элемент кэша ExLlamaV3: квантованный — биты + fp16-масштаб на 32 значения. */
export const exl3CacheBytes = (bits: number): number => (bits >= 16 ? 2 : (bits + 0.5) / 8)

const pad256 = (n: number): number => Math.ceil(Math.max(1, n) / 256) * 256

/** Равномерно «размазать» k особых слоёв по n (когда нет поштучной разметки). */
const spread = (il: number, k: number, n: number): boolean =>
  k > 0 && n > 0 && Math.floor(((il + 1) * k) / n) > Math.floor((il * k) / n)

export function layerKvHeads(a: ModelArchInfo, il: number): number {
  if (a.layerKvHeads) return a.layerKvHeads[il] ?? 0
  if (a.recurrentLayers >= a.nLayers) return 0
  return spread(il, a.recurrentLayers, a.nLayers) ? 0 : a.nHeadKv
}

export function layerIsSwa(a: ModelArchInfo, il: number): boolean {
  if (a.slidingWindow <= 0) return false
  if (a.layerSwa) return a.layerSwa[il] ?? false
  return spread(il, a.swaLayers, a.nLayers)
}

export function layerIsRecurrent(a: ModelArchInfo, il: number): boolean {
  if (a.layerRecurrent) return a.layerRecurrent[il] ?? false
  return spread(il, a.recurrentLayers, a.nLayers)
}

export interface KvOptions {
  engine?: EngineId
  /** Параллельные последовательности (--parallel). */
  nSeq?: number
  /** Общий KV для всех последовательностей (--kv-unified). */
  unified?: boolean
  /** Физический батч: SWA-кэш = окно + ubatch. */
  nUbatch?: number
  /** --swa-full: SWA-слоям полный контекст. */
  swaFull?: boolean
}

export interface KvGeometry {
  /** Ячеек у полного слоя и у SWA-слоя (всего по всем потокам). */
  cellsFull: number
  cellsSwa: number
}

export function kvGeometry(a: ModelArchInfo, nCtx: number, opts: KvOptions = {}): KvGeometry {
  const nSeq = Math.max(1, opts.nSeq ?? 1)
  const unified = opts.unified ?? true
  const ub = Math.max(1, opts.nUbatch ?? 512)
  if (opts.engine === 'exl3') {
    const c = pad256(nCtx)
    return { cellsFull: c, cellsSwa: c }
  }
  if (unified || nSeq === 1) {
    const full = pad256(nCtx)
    const swa = opts.swaFull ? full : Math.min(full, pad256(a.slidingWindow * nSeq + ub))
    return { cellsFull: full, cellsSwa: swa }
  }
  const perSeq = pad256(Math.floor(pad256(nCtx) / nSeq))
  const swa = opts.swaFull ? perSeq : Math.min(perSeq, pad256(a.slidingWindow + ub))
  return { cellsFull: perSeq * nSeq, cellsSwa: swa * nSeq }
}

/** KV одного слоя, байты (0 у слоёв без KV). */
export function layerKvBytes(
  a: ModelArchInfo,
  il: number,
  geo: KvGeometry,
  kType: KvCacheType,
  vType: KvCacheType,
  engine: EngineId = 'llamacpp'
): number {
  const heads = layerKvHeads(a, il)
  if (heads <= 0) return 0
  const swa = layerIsSwa(a, il)
  const cells = swa ? geo.cellsSwa : geo.cellsFull
  if (engine === 'exl3') {
    const kb = exl3CacheBytes(exl3CacheBits(kType))
    const vb = exl3CacheBytes(exl3CacheBits(vType))
    return Math.round(cells * heads * (a.headDimK * kb + a.headDimV * vb))
  }
  if (a.mlaKvDim > 0) {
    // MLA: в кэше только сжатый latent + rope-часть, отдельного V нет
    return Math.round(cells * a.mlaKvDim * kvTypeBytes(kType, a.mlaKvDim))
  }
  const hdK = swa ? (a.headDimKSwa ?? a.headDimK) : a.headDimK
  const hdV = swa ? (a.headDimVSwa ?? a.headDimV) : a.headDimV
  const kRow = heads * hdK
  const vRow = heads * hdV
  return Math.round(cells * (kRow * kvTypeBytes(kType, kRow) + vRow * kvTypeBytes(vType, vRow)))
}

/** Рекуррентное состояние слоя (r + s, f32) на все последовательности. */
export function layerStateBytes(a: ModelArchInfo, il: number, nSeq = 1): number {
  if (!layerIsRecurrent(a, il)) return 0
  return (a.recurrentStateElems ?? 0) * 4 * Math.max(1, nSeq)
}

/**
 * Полный KV-кэш модели (все слои + рекуррентные состояния), байты.
 * По умолчанию — llama.cpp, одна последовательность, ubatch 512.
 */
export function kvCacheBytes(
  arch: ModelArchInfo,
  nCtx: number,
  kType: KvCacheType = 'f16',
  vType: KvCacheType = 'f16',
  opts: KvOptions = {}
): number {
  const engine = opts.engine ?? 'llamacpp'
  const geo = kvGeometry(arch, nCtx, opts)
  let total = 0
  for (let il = 0; il < arch.nLayers; il++) {
    total += layerKvBytes(arch, il, geo, kType, vType, engine) + layerStateBytes(arch, il, opts.nSeq)
  }
  return total
}

/** KV на один токен контекста (полные слои; SWA-слои ограничены окном). */
export function kvBytesPerToken(arch: ModelArchInfo, kType: KvCacheType = 'f16', vType: KvCacheType = 'f16'): number {
  const geo = { cellsFull: 1, cellsSwa: 0 }
  let total = 0
  for (let il = 0; il < arch.nLayers; il++) total += layerKvBytes(arch, il, geo, kType, vType)
  return total
}
