// Парсер GGUF (v1–v3): заголовок, метаданные, описания тензоров.
// Работает поверх абстрактного читателя диапазонов — локальный файл или HTTP Range,
// поэтому годится и для моделей на диске, и для файлов на HuggingFace без скачивания.

import { promises as fs } from 'node:fs'
import { basename, dirname, join } from 'node:path'

const MiB = 1024 * 1024

// ---------- Читатели ----------

export interface RangeReader {
  read(offset: number, length: number): Promise<Buffer>
  /** Размер файла, если известен (у HTTP — после первого ответа). */
  size?: number
  close?(): Promise<void>
}

/** Локальный файл. Буферизацию делает курсор парсера. */
export async function openFileReader(path: string): Promise<RangeReader & { size: number; close(): Promise<void> }> {
  const fh = await fs.open(path, 'r')
  const { size } = await fh.stat()
  return {
    size,
    async read(offset: number, length: number): Promise<Buffer> {
      const len = Math.max(0, Math.min(length, size - offset))
      const buf = Buffer.allocUnsafe(len)
      let done = 0
      while (done < len) {
        const { bytesRead } = await fh.read(buf, done, len - done, offset + done)
        if (bytesRead === 0) break
        done += bytesRead
      }
      return done === len ? buf : buf.subarray(0, done)
    },
    close: () => fh.close()
  }
}

export interface HttpRangeReaderOptions {
  /** Размер блока запроса (по умолчанию 2 МиБ). */
  chunkSize?: number
  /** Сколько блоков держать в кэше. */
  maxCachedChunks?: number
  timeoutMs?: number
  fetch?: typeof fetch
}

export interface HttpRangeReader extends RangeReader {
  /** Сколько HTTP-запросов сделано (для тестов и отладки). */
  readonly requests: number
}

/**
 * Чтение по HTTP Range с кэшем блоков: много мелких чтений парсера
 * превращаются в несколько запросов по chunkSize.
 */
export function httpRangeReader(
  url: string,
  headers: Record<string, string> = {},
  opts: HttpRangeReaderOptions = {}
): HttpRangeReader {
  const chunk = Math.max(64 * 1024, opts.chunkSize ?? 2 * MiB)
  const maxChunks = Math.max(2, opts.maxCachedChunks ?? 64)
  const timeoutMs = opts.timeoutMs ?? 60_000
  const doFetch = opts.fetch ?? fetch
  const cache = new Map<number, Promise<Buffer>>()
  let requests = 0
  let size: number | undefined

  async function fetchChunk(i: number): Promise<Buffer> {
    const start = i * chunk
    let end = start + chunk - 1
    if (size !== undefined) {
      if (start >= size) return Buffer.alloc(0)
      end = Math.min(end, size - 1)
    }
    requests++
    const res = await doFetch(url, {
      headers: { ...headers, Range: `bytes=${start}-${end}` },
      signal: AbortSignal.timeout(timeoutMs)
    })
    if (res.status === 416) return Buffer.alloc(0)
    if (!res.ok) throw new Error(`HTTP ${res.status} при чтении ${url}`)
    if (res.status === 206) {
      const m = /\/(\d+)\s*$/.exec(res.headers.get('content-range') ?? '')
      if (m) size = Number(m[1])
      return Buffer.from(await res.arrayBuffer())
    }
    // Сервер проигнорировал Range (200): читаем поток только до нужного места.
    const total = Number(res.headers.get('content-length'))
    if (Number.isFinite(total) && total > 0) size = total
    const body = res.body
    if (!body) return Buffer.alloc(0)
    const reader = body.getReader()
    const parts: Buffer[] = []
    let got = 0
    try {
      while (got <= end) {
        const { done, value } = await reader.read()
        if (done) break
        parts.push(Buffer.from(value))
        got += value.byteLength
      }
    } finally {
      void reader.cancel().catch(() => undefined)
    }
    const all = Buffer.concat(parts)
    if (size === undefined && got < end + 1) size = got
    return all.subarray(start, Math.min(end + 1, all.length))
  }

  function getChunk(i: number): Promise<Buffer> {
    let p = cache.get(i)
    if (p) {
      // LRU: переставляем в конец
      cache.delete(i)
      cache.set(i, p)
      return p
    }
    p = fetchChunk(i)
    cache.set(i, p)
    p.catch(() => cache.delete(i))
    while (cache.size > maxChunks) {
      const oldest = cache.keys().next().value
      if (oldest === undefined) break
      cache.delete(oldest)
    }
    return p
  }

  return {
    get size() {
      return size
    },
    get requests() {
      return requests
    },
    async read(offset: number, length: number): Promise<Buffer> {
      if (length <= 0) return Buffer.alloc(0)
      const first = Math.floor(offset / chunk)
      const last = Math.floor((offset + length - 1) / chunk)
      const parts: Buffer[] = []
      for (let i = first; i <= last; i++) {
        const b = await getChunk(i)
        parts.push(b)
        if (b.length < chunk) break // конец файла
      }
      const all = parts.length === 1 ? parts[0]! : Buffer.concat(parts)
      const start = offset - first * chunk
      return all.subarray(Math.min(start, all.length), Math.min(start + length, all.length))
    }
  }
}

// ---------- Типы ggml ----------

interface TypeTraits {
  name: string
  /** Элементов в блоке. */
  blck: number
  /** Байт на блок. */
  size: number
  /** ik_llama.cpp: служебные байты на строку (масштаб строки и т.п.). */
  rowMeta?: number
}

const T = (name: string, blck: number, size: number, rowMeta?: number): TypeTraits => ({ name, blck, size, rowMeta })

/**
 * Таблица типов: mainline ggml (ggml/include/ggml.h, ggml/src/ggml.c) + типы ik_llama.cpp.
 * Размеры блоков сверены с ggml-common.h обоих проектов.
 */
export const GGML_TYPES: Readonly<Record<number, TypeTraits>> = {
  0: T('F32', 1, 4),
  1: T('F16', 1, 2),
  2: T('Q4_0', 32, 18),
  3: T('Q4_1', 32, 20),
  6: T('Q5_0', 32, 22),
  7: T('Q5_1', 32, 24),
  8: T('Q8_0', 32, 34),
  9: T('Q8_1', 32, 36),
  10: T('Q2_K', 256, 84),
  11: T('Q3_K', 256, 110),
  12: T('Q4_K', 256, 144),
  13: T('Q5_K', 256, 176),
  14: T('Q6_K', 256, 210),
  15: T('Q8_K', 256, 292),
  16: T('IQ2_XXS', 256, 66),
  17: T('IQ2_XS', 256, 74),
  18: T('IQ3_XXS', 256, 98),
  19: T('IQ1_S', 256, 50),
  20: T('IQ4_NL', 32, 18),
  21: T('IQ3_S', 256, 110),
  22: T('IQ2_S', 256, 82),
  23: T('IQ4_XS', 256, 136),
  24: T('I8', 1, 1),
  25: T('I16', 1, 2),
  26: T('I32', 1, 4),
  27: T('I64', 1, 8),
  28: T('F64', 1, 8),
  29: T('IQ1_M', 256, 56),
  30: T('BF16', 1, 2),
  31: T('Q4_0_4_4', 32, 18),
  32: T('Q4_0_4_8', 32, 18),
  33: T('Q4_0_8_8', 32, 18),
  34: T('TQ1_0', 256, 54),
  35: T('TQ2_0', 256, 66),
  // 36: в mainline удалённый IQ4_NL_4_4, в ik_llama.cpp — I2_S (BitNet); размер — по смещениям
  37: T('IQ4_NL_4_8', 32, 18),
  38: T('IQ4_NL_8_8', 32, 18),
  39: T('MXFP4', 32, 17),
  40: T('NVFP4', 64, 36),
  41: T('Q1_0', 128, 18), // в ik_llama.cpp тот же формат называется Q1_0_G128
  42: T('Q2_0', 64, 18),
  // ik_llama.cpp
  97: T('Q8_0_X4', 32, 34),
  98: T('Q8_1_X4', 32, 36),
  99: T('Q8_2_X4', 32, 36),
  133: T('Q6_0', 32, 26),
  134: T('IQ1_BN', 64, 13, 2),
  135: T('IQ2_BN', 64, 16, 4),
  136: T('Q8_K64', 64, 68),
  137: T('IQ2_K', 256, 76),
  138: T('IQ3_K', 256, 110),
  139: T('IQ4_K', 256, 144),
  140: T('IQ5_K', 256, 176),
  141: T('IQ6_K', 256, 212),
  142: T('PQ2_0', 128, 34),
  143: T('PTQ1_0', 128, 28),
  144: T('IQ4_KS', 256, 136, 4),
  145: T('IQ2_KS', 256, 70, 2),
  146: T('IQ4_KSS', 256, 128, 4),
  147: T('Q8_K16', 64, 64, 20),
  148: T('Q8_K32', 256, 292),
  149: T('Q8_KR8', 256, 292),
  150: T('Q8_K128', 128, 144),
  151: T('Q8_KV', 32, 32, 8),
  152: T('IQ5_KS', 256, 168, 4),
  153: T('IQ2_KT', 256, 68, 4),
  154: T('IQ3_KT', 256, 100, 4),
  155: T('IQ4_KT', 256, 128, 4),
  156: T('IQ3_KS', 256, 102, 2),
  157: T('IQ2_KL', 256, 86, 2),
  158: T('IQ1_KT', 256, 56, 4),
  159: T('Q1_0_G128_R8', 128, 18),
  160: T('PQ2_0_R8', 128, 34),
  161: T('PTQ1_0_R8', 128, 28),
  202: T('Q4_0_R8', 32, 18),
  206: T('Q5_0_R4', 32, 22),
  208: T('Q8_0_R8', 32, 34),
  210: T('Q2_K_R4', 256, 84),
  211: T('Q3_K_R4', 256, 110),
  212: T('Q4_K_R4', 256, 144),
  213: T('Q5_K_R4', 256, 176),
  214: T('Q6_K_R4', 256, 210),
  216: T('IQ2_XXS_R4', 256, 66),
  217: T('IQ2_XS_R4', 256, 74),
  218: T('IQ3_XXS_R4', 256, 98),
  219: T('IQ1_S_R4', 32, 6, 2),
  220: T('IQ4_NL_R4', 32, 18),
  221: T('IQ3_S_R4', 256, 110),
  222: T('IQ2_S_R4', 256, 82),
  223: T('IQ4_XS_R8', 256, 136),
  229: T('IQ1_M_R4', 32, 7, 2),
  230: T('BF16_R16', 1, 2),
  233: T('Q6_0_R4', 32, 26),
  335: T('IQ2_BN_R4', 64, 16, 4),
  337: T('IQ2_K_R4', 256, 76),
  338: T('IQ3_K_R4', 256, 110),
  339: T('IQ4_K_R4', 256, 144),
  340: T('IQ5_K_R4', 256, 176),
  344: T('IQ4_KS_R4', 256, 136, 4),
  345: T('IQ4_KS_R16', 32, 17, 4),
  346: T('IQ3_KS_R16', 32, 13, 4),
  352: T('IQ5_KS_R4', 256, 168, 4),
  353: T('MXFP4_R8', 32, 17),
  397: T('Q8_K_R16', 256, 260),
  398: T('Q8_KV_R8', 32, 32, 4),
  399: T('Q8_K_R8', 256, 258)
}

export function ggmlTypeName(type: number): string {
  return GGML_TYPES[type]?.name ?? (type === 36 ? 'I2_S' : `TYPE_${type}`)
}

/** Байты тензора по таблице типов; undefined — тип неизвестен. */
export function ggmlTensorBytes(type: number, dims: readonly number[]): number | undefined {
  const t = GGML_TYPES[type]
  if (!t) return undefined
  const ne0 = dims[0] ?? 1
  let rows = 1
  for (let i = 1; i < dims.length; i++) rows *= dims[i]!
  const rowBytes = (t.rowMeta ?? 0) + Math.ceil(ne0 / t.blck) * t.size
  return rows * rowBytes
}

/** Примерное число бит на вес у типа (для подписей). */
export function ggmlTypeBpw(type: number): number | undefined {
  const t = GGML_TYPES[type]
  return t ? (t.size * 8) / t.blck : undefined
}

// ---------- Значения метаданных ----------

export const GgufType = {
  UINT8: 0,
  INT8: 1,
  UINT16: 2,
  INT16: 3,
  UINT32: 4,
  INT32: 5,
  FLOAT32: 6,
  BOOL: 7,
  STRING: 8,
  ARRAY: 9,
  UINT64: 10,
  INT64: 11,
  FLOAT64: 12
} as const

export interface GgufArray {
  type: 'array'
  itemType: number
  length: number
  /** Нет, если массив большой (токены, merges, scores) — храним только длину. */
  values?: GgufValue[]
}

export type GgufValue = number | string | boolean | GgufArray

const FIXED_SIZE: Readonly<Record<number, number>> = {
  [GgufType.UINT8]: 1,
  [GgufType.INT8]: 1,
  [GgufType.UINT16]: 2,
  [GgufType.INT16]: 2,
  [GgufType.UINT32]: 4,
  [GgufType.INT32]: 4,
  [GgufType.FLOAT32]: 4,
  [GgufType.BOOL]: 1,
  [GgufType.UINT64]: 8,
  [GgufType.INT64]: 8,
  [GgufType.FLOAT64]: 8
}

/** Массивы, содержимое которых не нужно (только длина). */
const SKIP_ARRAY_KEYS = new Set([
  'tokenizer.ggml.tokens',
  'tokenizer.ggml.merges',
  'tokenizer.ggml.scores',
  'tokenizer.ggml.token_type',
  'tokenizer.ggml.precompiled_charsmap'
])
const ARRAY_KEEP_LIMIT = 4096
const STRING_ARRAY_KEEP_LIMIT = 1024

export class GgufError extends Error {}

// ---------- Курсор ----------

class Cursor {
  private buf: Buffer = Buffer.alloc(0)
  private base = 0
  pos: number

  constructor(
    private readonly reader: RangeReader,
    private readonly chunk: number,
    start = 0,
    /** v1: длины и счётчики — u32 вместо u64. */
    public wide = true
  ) {
    this.pos = start
  }

  has(n: number): boolean {
    const o = this.pos - this.base
    return o >= 0 && o + n <= this.buf.length
  }

  async need(n: number): Promise<void> {
    if (this.has(n)) return
    let len = Math.max(n, this.chunk)
    const size = this.reader.size
    if (size !== undefined) len = Math.min(len, size - this.pos)
    const b = len > 0 ? await this.reader.read(this.pos, len) : Buffer.alloc(0)
    if (b.length < n) throw new GgufError('Файл GGUF обрывается: заголовок неполный')
    this.buf = b
    this.base = this.pos
  }

  skip(n: number): void {
    this.pos += n
  }

  private take(n: number): number {
    const o = this.pos - this.base
    this.pos += n
    return o
  }

  u8(): number {
    return this.buf.readUInt8(this.take(1))
  }
  i8(): number {
    return this.buf.readInt8(this.take(1))
  }
  u16(): number {
    return this.buf.readUInt16LE(this.take(2))
  }
  i16(): number {
    return this.buf.readInt16LE(this.take(2))
  }
  u32(): number {
    return this.buf.readUInt32LE(this.take(4))
  }
  i32(): number {
    return this.buf.readInt32LE(this.take(4))
  }
  f32(): number {
    return this.buf.readFloatLE(this.take(4))
  }
  f64(): number {
    return this.buf.readDoubleLE(this.take(8))
  }
  u64(): number {
    const o = this.take(8)
    return this.buf.readUInt32LE(o) + this.buf.readUInt32LE(o + 4) * 0x1_0000_0000
  }
  i64(): number {
    const o = this.take(8)
    return this.buf.readUInt32LE(o) + this.buf.readInt32LE(o + 4) * 0x1_0000_0000
  }
  /** Длина строки / счётчик: u64 (v2+) или u32 (v1). */
  count(): number {
    return this.wide ? this.u64() : this.u32()
  }
  get countSize(): number {
    return this.wide ? 8 : 4
  }
  str(n: number): string {
    const o = this.take(n)
    return this.buf.toString('utf8', o, o + n)
  }

  readFixed(type: number): number | boolean {
    switch (type) {
      case GgufType.UINT8:
        return this.u8()
      case GgufType.INT8:
        return this.i8()
      case GgufType.UINT16:
        return this.u16()
      case GgufType.INT16:
        return this.i16()
      case GgufType.UINT32:
        return this.u32()
      case GgufType.INT32:
        return this.i32()
      case GgufType.FLOAT32:
        return this.f32()
      case GgufType.BOOL:
        return this.u8() !== 0
      case GgufType.UINT64:
        return this.u64()
      case GgufType.INT64:
        return this.i64()
      case GgufType.FLOAT64:
        return this.f64()
      default:
        throw new GgufError(`Неизвестный тип значения GGUF: ${type}`)
    }
  }
}

const MAX_STRING = 256 * MiB

async function readString(c: Cursor): Promise<string> {
  if (!c.has(c.countSize)) await c.need(c.countSize)
  const n = c.count()
  if (n > MAX_STRING) throw new GgufError('Повреждённый GGUF: слишком длинная строка')
  if (!c.has(n)) await c.need(n)
  return c.str(n)
}

async function readArray(c: Cursor, key: string, depth: number): Promise<GgufArray> {
  if (depth > 8) throw new GgufError('Повреждённый GGUF: слишком глубокая вложенность массивов')
  await c.need(4 + c.countSize)
  const itemType = c.u32()
  const length = c.count()
  const skipAll = SKIP_ARRAY_KEYS.has(key)
  const fixed = FIXED_SIZE[itemType]
  if (fixed !== undefined) {
    if (skipAll || length > ARRAY_KEEP_LIMIT) {
      c.skip(length * fixed)
      return { type: 'array', itemType, length }
    }
    await c.need(length * fixed)
    const values: GgufValue[] = new Array<GgufValue>(length)
    for (let i = 0; i < length; i++) values[i] = c.readFixed(itemType)
    return { type: 'array', itemType, length, values }
  }
  if (itemType === GgufType.STRING) {
    const keep = !skipAll && length <= STRING_ARRAY_KEEP_LIMIT
    const values: GgufValue[] | undefined = keep ? [] : undefined
    const cs = c.countSize
    for (let i = 0; i < length; i++) {
      if (!c.has(cs)) await c.need(cs)
      const n = c.count()
      if (n > MAX_STRING) throw new GgufError('Повреждённый GGUF: слишком длинная строка')
      if (values) {
        if (!c.has(n)) await c.need(n)
        values.push(c.str(n))
      } else {
        c.skip(n)
      }
    }
    return { type: 'array', itemType, length, values }
  }
  if (itemType === GgufType.ARRAY) {
    const keep = !skipAll && length <= ARRAY_KEEP_LIMIT
    const values: GgufValue[] | undefined = keep ? [] : undefined
    for (let i = 0; i < length; i++) {
      const sub = await readArray(c, key, depth + 1)
      values?.push(sub)
    }
    return { type: 'array', itemType, length, values }
  }
  throw new GgufError(`Неизвестный тип элементов массива GGUF: ${itemType}`)
}

async function readValue(c: Cursor, type: number, key: string): Promise<GgufValue> {
  if (type === GgufType.STRING) return readString(c)
  if (type === GgufType.ARRAY) return readArray(c, key, 0)
  const size = FIXED_SIZE[type]
  if (size === undefined) throw new GgufError(`Неизвестный тип значения GGUF: ${type}`)
  if (!c.has(size)) await c.need(size)
  return c.readFixed(type)
}

// ---------- Разбор файла ----------

export interface GgufTensor {
  name: string
  dims: number[]
  type: number
  /** Смещение относительно начала области данных своего шарда. */
  offset: number
  /** Байты тензора (по смещениям; таблица типов — запасной вариант). */
  size: number
  nElements: number
  /** Номер шарда (0 — первый файл). */
  shard: number
}

export interface GgufFile {
  version: number
  metadata: Record<string, GgufValue>
  tensors: GgufTensor[]
  alignment: number
  /** Начало области данных первого шарда. */
  dataOffset: number
  /** Суммарный размер файлов, если известен. */
  totalSize?: number
  shards: number
  /** true — часть размеров оценена (неизвестный тип без опоры на смещения). */
  estimatedSizes: boolean
}

export interface ParseOptions {
  /** Размер окна чтения курсора (по умолчанию 1 МиБ). */
  chunkSize?: number
  /** Номер шарда для тензоров. */
  shard?: number
}

const GGUF_MAGIC = 0x46554747 // "GGUF" LE

export async function parseGguf(reader: RangeReader, opts: ParseOptions = {}): Promise<GgufFile> {
  const c = new Cursor(reader, opts.chunkSize ?? MiB)
  await c.need(8)
  const magic = c.u32()
  if (magic !== GGUF_MAGIC) throw new GgufError('Это не файл GGUF (неверная сигнатура)')
  const version = c.u32()
  if (version > 0xffff) throw new GgufError('GGUF с обратным порядком байт (big-endian) не поддерживается')
  if (version < 1 || version > 3) throw new GgufError(`Неподдерживаемая версия GGUF: ${version}`)
  c.wide = version >= 2

  await c.need(c.countSize * 2)
  const nTensors = c.count()
  const nKv = c.count()
  if (nTensors > 1_000_000 || nKv > 1_000_000) throw new GgufError('Повреждённый GGUF: неправдоподобные счётчики')

  const metadata: Record<string, GgufValue> = {}
  for (let i = 0; i < nKv; i++) {
    const key = await readString(c)
    await c.need(4)
    const type = c.u32()
    metadata[key] = await readValue(c, type, key)
  }

  const shard = opts.shard ?? 0
  const tensors: GgufTensor[] = new Array<GgufTensor>(nTensors)
  for (let i = 0; i < nTensors; i++) {
    const name = await readString(c)
    await c.need(4)
    const nDims = c.u32()
    if (nDims > 8) throw new GgufError(`Повреждённый GGUF: у тензора ${name} ${nDims} измерений`)
    await c.need(nDims * c.countSize + 4 + 8)
    const dims: number[] = []
    let nElements = 1
    for (let d = 0; d < nDims; d++) {
      const v = c.count()
      dims.push(v)
      nElements *= v
    }
    const type = c.u32()
    const offset = c.u64()
    tensors[i] = { name, dims, type, offset, size: 0, nElements, shard }
  }

  const alignRaw = metadata['general.alignment']
  const alignment = typeof alignRaw === 'number' && alignRaw > 0 ? alignRaw : 32
  const dataOffset = Math.ceil(c.pos / alignment) * alignment
  const dataSize = reader.size !== undefined ? Math.max(0, reader.size - dataOffset) : undefined
  const estimatedSizes = assignSizes(tensors, dataSize)

  return {
    version,
    metadata,
    tensors,
    alignment,
    dataOffset,
    totalSize: reader.size,
    shards: 1,
    estimatedSizes
  }
}

/**
 * Размеры тензоров: разность соседних смещений (надёжно, включает выравнивание),
 * для последнего — до конца файла. Если тип известен и его размер не больше разности —
 * берём точный размер по таблице. Возвращает true, если что-то пришлось угадывать.
 */
function assignSizes(tensors: GgufTensor[], dataSize: number | undefined): boolean {
  const order = tensors.map((_, i) => i).sort((a, b) => tensors[a]!.offset - tensors[b]!.offset)
  let estimated = false
  const unknown: GgufTensor[] = []
  for (let k = 0; k < order.length; k++) {
    const t = tensors[order[k]!]!
    const next = k + 1 < order.length ? tensors[order[k + 1]!]! : undefined
    const delta = next ? next.offset - t.offset : dataSize !== undefined ? dataSize - t.offset : undefined
    const table = ggmlTensorBytes(t.type, t.dims)
    if (delta !== undefined && delta >= 0) {
      t.size = table !== undefined && table <= delta ? table : delta
    } else if (table !== undefined) {
      t.size = table
    } else {
      unknown.push(t)
    }
  }
  // Неизвестный тип без опоры на смещения: средние байты/элемент у тензоров того же типа.
  for (const t of unknown) {
    estimated = true
    let bytes = 0
    let elems = 0
    for (const o of tensors) {
      if (o !== t && o.type === t.type && o.size > 0) {
        bytes += o.size
        elems += o.nElements
      }
    }
    t.size = elems > 0 ? Math.round((t.nElements * bytes) / elems) : Math.round(t.nElements * 0.5)
  }
  return estimated
}

// ---------- Шарды ----------

const SHARD_RE = /^(.*)-(\d{5})-of-(\d{5})\.gguf$/i

export interface ShardInfo {
  /** Имя без суффикса шарда и расширения. */
  base: string
  /** 1-based. */
  index: number
  count: number
}

export function ggufShardInfo(fileName: string): ShardInfo | null {
  const m = SHARD_RE.exec(basename(fileName))
  if (!m) return null
  const index = Number(m[2])
  const count = Number(m[3])
  if (index < 1 || count < 1 || index > count) return null
  return { base: m[1]!, index, count }
}

/** Пути всех шардов по пути любого из них (или [path], если файл не шардирован). */
export function ggufShardPaths(path: string): string[] {
  const info = ggufShardInfo(path)
  if (!info) return [path]
  const dir = dirname(path)
  const ext = /\.gguf$/i.exec(path)?.[0] ?? '.gguf'
  const pad = (n: number): string => String(n).padStart(5, '0')
  const out: string[] = []
  for (let i = 1; i <= info.count; i++) out.push(join(dir, `${info.base}-${pad(i)}-of-${pad(info.count)}${ext}`))
  return out
}

/** Объединяет разобранные шарды: метаданные первого, тензоры всех. */
export function mergeShards(parts: GgufFile[]): GgufFile {
  if (parts.length === 0) throw new GgufError('Нет шардов GGUF')
  if (parts.length === 1) return parts[0]!
  const first = parts[0]!
  const tensors: GgufTensor[] = []
  let total: number | undefined = 0
  let estimated = false
  parts.forEach((p, i) => {
    for (const t of p.tensors) tensors.push({ ...t, shard: i })
    total = total !== undefined && p.totalSize !== undefined ? total + p.totalSize : undefined
    estimated ||= p.estimatedSizes
  })
  return { ...first, tensors, totalSize: total, shards: parts.length, estimatedSizes: estimated }
}

/** Разбирает набор читателей-шардов (локальных или HTTP) по порядку. */
export async function parseGgufShards(readers: RangeReader[], opts: ParseOptions = {}): Promise<GgufFile> {
  const parts: GgufFile[] = []
  for (let i = 0; i < readers.length; i++) parts.push(await parseGguf(readers[i]!, { ...opts, shard: i }))
  return mergeShards(parts)
}

/** Локальная модель: путь к любому шарду или одиночному файлу. */
export async function readGgufModel(path: string): Promise<GgufFile> {
  const paths = ggufShardPaths(path)
  const parts: GgufFile[] = []
  for (let i = 0; i < paths.length; i++) {
    const r = await openFileReader(paths[i]!)
    try {
      parts.push(await parseGguf(r, { shard: i }))
    } finally {
      await r.close()
    }
  }
  return mergeShards(parts)
}

// ---------- Удобные геттеры метаданных ----------

export function mdNumber(md: Record<string, GgufValue>, key: string): number | undefined {
  const v = md[key]
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'boolean') return v ? 1 : 0
  return undefined
}

export function mdString(md: Record<string, GgufValue>, key: string): string | undefined {
  const v = md[key]
  return typeof v === 'string' ? v : undefined
}

export function mdBool(md: Record<string, GgufValue>, key: string): boolean | undefined {
  const v = md[key]
  if (typeof v === 'boolean') return v
  if (typeof v === 'number') return v !== 0
  return undefined
}

export function mdArray(md: Record<string, GgufValue>, key: string): GgufArray | undefined {
  const v = md[key]
  return typeof v === 'object' && v !== null && v.type === 'array' ? v : undefined
}

/** Число или массив чисел (по слоям) → массив длины n. */
export function mdPerLayer(md: Record<string, GgufValue>, key: string, n: number): number[] | undefined {
  const v = md[key]
  if (typeof v === 'number') return new Array<number>(n).fill(v)
  const arr = mdArray(md, key)
  if (!arr?.values) return undefined
  const out = new Array<number>(n).fill(0)
  for (let i = 0; i < n; i++) {
    const x = arr.values[i]
    out[i] = typeof x === 'number' ? x : typeof x === 'boolean' ? (x ? 1 : 0) : 0
  }
  return out
}
