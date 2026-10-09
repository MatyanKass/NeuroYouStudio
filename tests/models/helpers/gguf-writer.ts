// Мини-писатель GGUF для тестов: метаданные любых типов + тензоры с нулевыми данными.
import { ggmlTensorBytes } from '../../../src/main/models/gguf'

export type WValue =
  | { t: 'u8' | 'i8' | 'u16' | 'i16' | 'u32' | 'i32' | 'f32' | 'u64' | 'i64' | 'f64'; v: number }
  | { t: 'bool'; v: boolean }
  | { t: 'str'; v: string }
  | { t: 'arr'; item: Exclude<WValue['t'], 'arr'> | 'arr'; v: WValue[] }

export const u32 = (v: number): WValue => ({ t: 'u32', v })
export const i32 = (v: number): WValue => ({ t: 'i32', v })
export const u64 = (v: number): WValue => ({ t: 'u64', v })
export const f32 = (v: number): WValue => ({ t: 'f32', v })
export const bool = (v: boolean): WValue => ({ t: 'bool', v })
export const str = (v: string): WValue => ({ t: 'str', v })
export const arrI32 = (v: number[]): WValue => ({ t: 'arr', item: 'i32', v: v.map(i32) })
export const arrF32 = (v: number[]): WValue => ({ t: 'arr', item: 'f32', v: v.map(f32) })
export const arrBool = (v: boolean[]): WValue => ({ t: 'arr', item: 'bool', v: v.map(bool) })
export const arrStr = (v: string[]): WValue => ({ t: 'arr', item: 'str', v: v.map(str) })

const TYPE_ID: Record<string, number> = {
  u8: 0,
  i8: 1,
  u16: 2,
  i16: 3,
  u32: 4,
  i32: 5,
  f32: 6,
  bool: 7,
  str: 8,
  arr: 9,
  u64: 10,
  i64: 11,
  f64: 12
}

export interface WTensor {
  name: string
  dims: number[]
  type: number
  /** Байты данных (по умолчанию — по таблице типов). */
  size?: number
}

export interface WriteOptions {
  version?: number
  kv: Array<[string, WValue]>
  tensors: WTensor[]
  alignment?: number
}

class Out {
  parts: Buffer[] = []
  len = 0
  push(b: Buffer): void {
    this.parts.push(b)
    this.len += b.length
  }
  u32(v: number): void {
    const b = Buffer.alloc(4)
    b.writeUInt32LE(v)
    this.push(b)
  }
  u64(v: number): void {
    const b = Buffer.alloc(8)
    b.writeBigUInt64LE(BigInt(v))
    this.push(b)
  }
}

export function writeGguf(o: WriteOptions): Buffer {
  const version = o.version ?? 3
  const wide = version >= 2
  const out = new Out()
  const count = (n: number): void => (wide ? out.u64(n) : out.u32(n))
  const string = (s: string): void => {
    const b = Buffer.from(s, 'utf8')
    count(b.length)
    out.push(b)
  }
  const scalar = (v: WValue): void => {
    let b: Buffer
    switch (v.t) {
      case 'u8':
        b = Buffer.alloc(1)
        b.writeUInt8(v.v)
        break
      case 'i8':
        b = Buffer.alloc(1)
        b.writeInt8(v.v)
        break
      case 'u16':
        b = Buffer.alloc(2)
        b.writeUInt16LE(v.v)
        break
      case 'i16':
        b = Buffer.alloc(2)
        b.writeInt16LE(v.v)
        break
      case 'u32':
        b = Buffer.alloc(4)
        b.writeUInt32LE(v.v)
        break
      case 'i32':
        b = Buffer.alloc(4)
        b.writeInt32LE(v.v)
        break
      case 'f32':
        b = Buffer.alloc(4)
        b.writeFloatLE(v.v)
        break
      case 'f64':
        b = Buffer.alloc(8)
        b.writeDoubleLE(v.v)
        break
      case 'u64':
        b = Buffer.alloc(8)
        b.writeBigUInt64LE(BigInt(v.v))
        break
      case 'i64':
        b = Buffer.alloc(8)
        b.writeBigInt64LE(BigInt(v.v))
        break
      case 'bool':
        b = Buffer.from([v.v ? 1 : 0])
        break
      case 'str':
        string(v.v)
        return
      case 'arr':
        out.u32(TYPE_ID[v.item]!)
        count(v.v.length)
        for (const x of v.v) scalar(x)
        return
    }
    out.push(b)
  }

  out.u32(0x46554747)
  out.u32(version)
  count(o.tensors.length)
  count(o.kv.length)
  for (const [k, v] of o.kv) {
    string(k)
    out.u32(TYPE_ID[v.t]!)
    scalar(v)
  }

  const alignment = o.alignment ?? 32
  const sizes = o.tensors.map((t) => t.size ?? ggmlTensorBytes(t.type, t.dims) ?? 0)
  let off = 0
  const offsets: number[] = []
  for (const s of sizes) {
    offsets.push(off)
    off = Math.ceil((off + s) / alignment) * alignment
  }
  o.tensors.forEach((t, i) => {
    string(t.name)
    out.u32(t.dims.length)
    for (const d of t.dims) count(d)
    out.u32(t.type)
    out.u64(offsets[i]!)
  })
  const headerEnd = Math.ceil(out.len / alignment) * alignment
  out.push(Buffer.alloc(headerEnd - out.len))
  // данные: последний тензор без хвостового выравнивания
  const last = o.tensors.length ? offsets[offsets.length - 1]! + sizes[sizes.length - 1]! : 0
  out.push(Buffer.alloc(last))
  return Buffer.concat(out.parts)
}

/** ggml типы для тестов. */
export const GT = { F32: 0, F16: 1, Q4_0: 2, Q8_0: 8, Q4_K: 12, Q6_K: 14, IQ4_XS: 23, BF16: 30, IQ4_KS: 144 } as const
