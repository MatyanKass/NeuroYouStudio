import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  GgufError,
  ggmlTensorBytes,
  ggufShardInfo,
  ggufShardPaths,
  httpRangeReader,
  mdArray,
  mdNumber,
  mdString,
  openFileReader,
  parseGguf,
  readGgufModel,
  type RangeReader
} from '../../src/main/models/gguf'
import { GT, arrI32, str, u32, writeGguf, type WValue } from './helpers/gguf-writer'
import { N_EMBD, N_VOCAB, gemmaLike, moeLike } from './fixtures'

const bufReader = (b: Buffer, withSize = true): RangeReader & { reads: number } => {
  const r = {
    reads: 0,
    size: withSize ? b.length : undefined,
    async read(offset: number, length: number) {
      r.reads++
      return b.subarray(offset, Math.min(b.length, offset + length))
    }
  }
  return r
}

let dir: string
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'nys-gguf-'))
})
afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('ggml type table', () => {
  it('block sizes match ggml', () => {
    expect(ggmlTensorBytes(GT.F32, [10, 3])).toBe(120)
    expect(ggmlTensorBytes(GT.Q8_0, [64, 2])).toBe(2 * 2 * 34)
    expect(ggmlTensorBytes(GT.Q4_K, [256, 4])).toBe(4 * 144)
    expect(ggmlTensorBytes(GT.Q6_K, [512, 1])).toBe(2 * 210)
    expect(ggmlTensorBytes(GT.IQ4_XS, [256, 1])).toBe(136)
    expect(ggmlTensorBytes(39, [32, 1])).toBe(17) // MXFP4
    expect(ggmlTensorBytes(40, [64, 1])).toBe(36) // NVFP4
    // ik_llama.cpp: IQ4_KS — 4 байта масштаба на строку
    expect(ggmlTensorBytes(GT.IQ4_KS, [256, 2])).toBe(2 * (4 + 136))
    expect(ggmlTensorBytes(12345, [1])).toBeUndefined()
  })
})

describe('parseGguf', () => {
  it('parses header, metadata and tensors of a synthetic model', async () => {
    const { buf, tensors } = gemmaLike()
    const g = await parseGguf(bufReader(buf))
    expect(g.version).toBe(3)
    expect(g.tensors).toHaveLength(tensors.length)
    expect(mdString(g.metadata, 'general.architecture')).toBe('gemma3')
    expect(mdNumber(g.metadata, 'gemma3.block_count')).toBe(6)
    // большой массив токенов — только длина
    const tok = mdArray(g.metadata, 'tokenizer.ggml.tokens')
    expect(tok?.length).toBe(N_VOCAB)
    expect(tok?.values).toBeUndefined()
    expect(mdArray(g.metadata, 'tokenizer.ggml.scores')?.values).toBeUndefined()
    // маленький массив по слоям — со значениями
    expect(mdArray(g.metadata, 'gemma3.attention.head_count_kv')?.values).toEqual([2, 2, 2, 2, 2, 1])
    expect(mdString(g.metadata, 'tokenizer.chat_template')).toContain('messages')
    expect(g.metadata['tokenizer.ggml.add_bos_token']).toBe(true)
    expect(g.dataOffset % 32).toBe(0)

    const byName = new Map(g.tensors.map((t) => [t.name, t]))
    expect(byName.get('token_embd.weight')?.size).toBe(N_VOCAB * (N_EMBD / 32) * 34)
    expect(byName.get('blk.1.attn_q.weight')?.size).toBe(64 * 144)
    // неизвестный тип в середине — по смещениям (с выравниванием до 32)
    expect(byName.get('blk.0.attn_q.weight')?.size).toBe(Math.ceil(5000 / 32) * 32)
    // неизвестный тип в конце — до конца файла
    expect(byName.get('rope_freqs.weight')?.size).toBe(96)
    expect(g.estimatedSizes).toBe(false)
    const dataBytes = g.tensors.reduce((s, t) => s + t.size, 0)
    expect(dataBytes).toBeLessThanOrEqual(buf.length - g.dataOffset)
    expect(dataBytes).toBeGreaterThan((buf.length - g.dataOffset) * 0.95)
  })

  it('estimates the last unknown tensor when the file size is unknown', async () => {
    const { buf } = gemmaLike()
    const g = await parseGguf(bufReader(buf, false))
    expect(g.estimatedSizes).toBe(true)
    expect(g.tensors.find((t) => t.name === 'rope_freqs.weight')!.size).toBeGreaterThan(0)
  })

  it('reads GGUF v1 (u32 counts) and nested arrays', async () => {
    const nested: WValue = { t: 'arr', item: 'arr', v: [arrI32([1, 2]), arrI32([3])] }
    const buf = writeGguf({
      version: 1,
      kv: [
        ['general.architecture', str('llama')],
        ['x.nested', nested],
        ['llama.block_count', u32(1)]
      ],
      tensors: [{ name: 'token_embd.weight', dims: [32, 4], type: GT.F16 }]
    })
    const g = await parseGguf(bufReader(buf))
    expect(g.version).toBe(1)
    const arr = mdArray(g.metadata, 'x.nested')
    expect(arr?.length).toBe(2)
    expect(arr?.values?.[0]).toMatchObject({ type: 'array', length: 2, values: [1, 2] })
    expect(g.tensors[0]!.size).toBe(32 * 4 * 2)
  })

  it('rejects non-GGUF and truncated files', async () => {
    await expect(parseGguf(bufReader(Buffer.from('not a gguf file at all')))).rejects.toThrow(GgufError)
    const { buf } = gemmaLike()
    await expect(parseGguf(bufReader(buf.subarray(0, 2000)))).rejects.toThrow(/обрывается/)
  })

  it('is reasonably fast with large tokenizer arrays', async () => {
    const n = 150_000
    const buf = writeGguf({
      kv: [
        ['general.architecture', str('llama')],
        ['tokenizer.ggml.tokens', { t: 'arr', item: 'str', v: Array.from({ length: n }, (_, i) => str(`t${i}`)) }],
        ['tokenizer.ggml.scores', { t: 'arr', item: 'f32', v: Array.from({ length: n }, () => ({ t: 'f32', v: 0 }) as WValue) }]
      ],
      tensors: [{ name: 'token_embd.weight', dims: [32, 2], type: GT.F32 }]
    })
    const t0 = performance.now()
    const r = bufReader(buf)
    const g = await parseGguf(r, { chunkSize: 1 << 20 })
    expect(performance.now() - t0).toBeLessThan(2000)
    expect(mdArray(g.metadata, 'tokenizer.ggml.tokens')?.length).toBe(n)
    expect(r.reads).toBeLessThan(10)
  })
})

describe('local files and shards', () => {
  it('opens a local file through the buffered reader', async () => {
    const { buf } = gemmaLike()
    const p = join(dir, 'gemma-Q4_K_M.gguf')
    await writeFile(p, buf)
    const r = await openFileReader(p)
    try {
      const g = await parseGguf(r)
      expect(g.totalSize).toBe(buf.length)
    } finally {
      await r.close()
    }
  })

  it('recognises shard names', () => {
    expect(ggufShardInfo('Qwen3-235B-Q4_K_M-00002-of-00005.gguf')).toEqual({
      base: 'Qwen3-235B-Q4_K_M',
      index: 2,
      count: 5
    })
    expect(ggufShardInfo('model.gguf')).toBeNull()
    const paths = ggufShardPaths(join('d', 'm-00003-of-00003.gguf'))
    expect(paths).toEqual([join('d', 'm-00001-of-00003.gguf'), join('d', 'm-00002-of-00003.gguf'), join('d', 'm-00003-of-00003.gguf')])
  })

  it('merges tensors from all shards, metadata from the first', async () => {
    const whole = moeLike()
    const split = moeLike(20)
    const a = join(dir, 'moe-Q4_K_M-00001-of-00002.gguf')
    const b = join(dir, 'moe-Q4_K_M-00002-of-00002.gguf')
    await writeFile(a, split.bufs[0]!)
    await writeFile(b, split.bufs[1]!)
    const g = await readGgufModel(b) // любой шард
    expect(g.shards).toBe(2)
    expect(g.tensors).toHaveLength(whole.tensors.length)
    expect(g.tensors.filter((t) => t.shard === 1)).toHaveLength(whole.tensors.length - 20)
    expect(mdString(g.metadata, 'general.architecture')).toBe('glm4moe')
    const single = await parseGguf(bufReader(whole.bufs[0]!))
    const sum = (x: { tensors: Array<{ size: number }> }): number => x.tensors.reduce((s, t) => s + t.size, 0)
    expect(sum(g)).toBe(sum(single))
  })
})

describe('httpRangeReader', () => {
  function fakeFetch(buf: Buffer, honorRange = true): { fetch: typeof fetch; calls: string[] } {
    const calls: string[] = []
    const f = (async (_url: string | URL | Request, init?: RequestInit) => {
      const range = new Headers(init?.headers).get('range') ?? ''
      calls.push(range)
      const m = /bytes=(\d+)-(\d+)/.exec(range)
      if (!honorRange || !m) {
        return new Response(new Uint8Array(buf), { status: 200, headers: { 'content-length': String(buf.length) } })
      }
      const s = Number(m[1])
      const e = Math.min(Number(m[2]), buf.length - 1)
      if (s >= buf.length) return new Response(null, { status: 416 })
      return new Response(new Uint8Array(buf.subarray(s, e + 1)), {
        status: 206,
        headers: { 'content-range': `bytes ${s}-${e}/${buf.length}` }
      })
    }) as typeof fetch
    return { fetch: f, calls }
  }

  it('turns many small reads into a few chunked range requests', async () => {
    const { buf } = gemmaLike()
    const ff = fakeFetch(buf)
    const r = httpRangeReader('https://example.test/m.gguf', { Authorization: 'Bearer x' }, { chunkSize: 64 * 1024, fetch: ff.fetch })
    const g = await parseGguf(r, { chunkSize: 16 * 1024 })
    expect(r.size).toBe(buf.length)
    expect(g.tensors.find((t) => t.name === 'rope_freqs.weight')!.size).toBe(96)
    expect(ff.calls.length).toBeLessThanOrEqual(Math.ceil(buf.length / (64 * 1024)) + 1)
    expect(ff.calls[0]).toBe('bytes=0-65535')
  })

  it('works when the server ignores Range', async () => {
    const { buf } = gemmaLike()
    const ff = fakeFetch(buf, false)
    const r = httpRangeReader('https://example.test/m.gguf', {}, { chunkSize: 1 << 20, fetch: ff.fetch })
    const g = await parseGguf(r)
    expect(g.tensors.length).toBeGreaterThan(10)
  })
})
