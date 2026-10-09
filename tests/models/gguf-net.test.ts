// Проверка на настоящих GGUF с HuggingFace через HTTP Range (только заголовки).
// Запуск: NYS_NET_TESTS=1 npx vitest run tests/models/gguf-net.test.ts
import { describe, expect, it } from 'vitest'
import { httpRangeReader, parseGguf } from '../../src/main/models/gguf'
import { describeGguf } from '../../src/main/models/gguf-info'
import { kvBytesPerToken } from '../../src/main/memory/kv'

const hf = (repo: string, file: string): string => `https://huggingface.co/${repo}/resolve/main/${file}`

async function load(repo: string, file: string) {
  const r = httpRangeReader(hf(repo, file), {}, { chunkSize: 4 * 1024 * 1024 })
  const g = await parseGguf(r, { chunkSize: 1024 * 1024 })
  return { g, d: describeGguf(g, file), requests: r.requests, size: r.size! }
}

const sumSizes = (ts: Array<{ size: number }>): number => ts.reduce((s, t) => s + t.size, 0)

describe.skipIf(!process.env.NYS_NET_TESTS)('real GGUF over HTTP Range', () => {
  it('Qwen3-0.6B Q8_0: dense, tied embeddings', { timeout: 60_000 }, async () => {
    const { g, d, requests, size } = await load('Qwen/Qwen3-0.6B-GGUF', 'Qwen3-0.6B-Q8_0.gguf')
    expect(requests).toBeLessThanOrEqual(3)
    const a = d.arch!
    expect(a.arch).toBe('qwen3')
    expect(a.nLayers).toBe(28)
    expect(a.nEmbd).toBe(1024)
    expect(a.nHead).toBe(16)
    expect(a.nHeadKv).toBe(8)
    expect(a.headDimK).toBe(128)
    expect(a.contextLengthMax).toBe(40960)
    expect(a.vocabSize).toBe(151936)
    expect(kvBytesPerToken(a)).toBe(28 * 2 * 8 * 128 * 2)
    expect(d.quant).toBe('Q8_0')
    expect(d.tensors.tiedOutput).toBe(true)
    expect(d.chatTemplate).toContain('<|im_start|>')
    // тензоры покрывают всю область данных
    expect(sumSizes(g.tensors)).toBeLessThanOrEqual(size - g.dataOffset)
    expect(sumSizes(g.tensors)).toBeGreaterThan((size - g.dataOffset) * 0.999)
  })

  it('Qwen3-30B-A3B Q4_K_M: MoE experts', { timeout: 60_000 }, async () => {
    const { g, d, size } = await load('unsloth/Qwen3-30B-A3B-GGUF', 'Qwen3-30B-A3B-Q4_K_M.gguf')
    const a = d.arch!
    expect(a.nLayers).toBe(48)
    expect(a.nExperts).toBe(128)
    expect(a.nExpertsUsed).toBe(8)
    expect(d.isMoe).toBe(true)
    const experts = d.tensors.layers.reduce((s, l) => s + l.experts, 0)
    expect(experts / (size - g.dataOffset)).toBeGreaterThan(0.85)
    expect(d.paramsLabel).toMatch(/30B/)
    expect(sumSizes(g.tensors)).toBeGreaterThan((size - g.dataOffset) * 0.999)
  })

  it('gemma-3-1b: SWA 5 of 6 layers', { timeout: 60_000 }, async () => {
    const { d } = await load('ggml-org/gemma-3-1b-it-GGUF', 'gemma-3-1b-it-Q4_K_M.gguf')
    const a = d.arch!
    expect(a.nLayers).toBe(26)
    expect(a.slidingWindow).toBe(512)
    expect(a.layerSwa?.slice(0, 6)).toEqual([true, true, true, true, true, false])
    expect(a.swaLayers).toBe(22)
  })

  it('gpt-oss-20b MXFP4: alternating SWA, MXFP4 experts', { timeout: 60_000 }, async () => {
    const { g, d, size } = await load('ggml-org/gpt-oss-20b-GGUF', 'gpt-oss-20b-MXFP4.gguf')
    const a = d.arch!
    expect(a.arch).toBe('gpt-oss')
    expect(a.layerSwa?.slice(0, 4)).toEqual([true, false, true, false])
    expect(d.isMoe).toBe(true)
    expect(g.tensors.some((t) => t.type === 39)).toBe(true)
    expect(sumSizes(g.tensors)).toBeGreaterThan((size - g.dataOffset) * 0.999)
  })
})
