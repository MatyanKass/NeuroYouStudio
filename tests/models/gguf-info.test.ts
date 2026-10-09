import { describe, expect, it } from 'vitest'
import { parseGguf, type GgufFile, type RangeReader } from '../../src/main/models/gguf'
import {
  classifyLayerTensor,
  describeGguf,
  formatParamCount,
  ftypeLabel,
  ggufArchInfo,
  quantFromFileName
} from '../../src/main/models/gguf-info'
import { arrBool, arrI32, f32, str, u32, writeGguf, type WValue } from './helpers/gguf-writer'
import { N_EMBD, N_VOCAB, gemmaLike, mmprojLike, moeLike } from './fixtures'

const reader = (b: Buffer): RangeReader => ({
  size: b.length,
  read: async (o, l) => b.subarray(o, Math.min(b.length, o + l))
})
const parse = (b: Buffer): Promise<GgufFile> => parseGguf(reader(b))
const metaOnly = (kv: Array<[string, WValue]>): Promise<GgufFile> => parse(writeGguf({ kv, tensors: [] }))

describe('ggufArchInfo', () => {
  it('derives arch, per-layer KV heads and gemma3 SWA pattern (5 of 6)', async () => {
    const g = await parse(gemmaLike().buf)
    const a = ggufArchInfo(g)!
    expect(a.arch).toBe('gemma3')
    expect(a.nLayers).toBe(6)
    expect(a.nEmbd).toBe(N_EMBD)
    expect(a.nHead).toBe(4)
    expect(a.nHeadKv).toBe(2)
    expect(a.layerKvHeads).toEqual([2, 2, 2, 2, 2, 1])
    expect(a.headDimK).toBe(16)
    expect(a.slidingWindow).toBe(512)
    expect(a.layerSwa).toEqual([true, true, true, true, true, false])
    expect(a.swaLayers).toBe(5)
    expect(a.vocabSize).toBe(N_VOCAB)
    expect(a.contextLengthMax).toBe(32768)
    expect(a.recurrentLayers).toBe(0)
    expect(a.mlaKvDim).toBe(0)
  })

  it('gemma3 without sliding_window has no SWA; explicit pattern array wins', async () => {
    const base: Array<[string, WValue]> = [
      ['general.architecture', str('gemma3')],
      ['gemma3.block_count', u32(4)],
      ['gemma3.embedding_length', u32(64)],
      ['gemma3.attention.head_count', u32(4)]
    ]
    expect((ggufArchInfo(await metaOnly(base)))!.swaLayers).toBe(0)
    const a = ggufArchInfo(
      await metaOnly([
        ...base,
        ['gemma3.attention.sliding_window', u32(1024)],
        ['gemma3.attention.sliding_window_pattern', arrBool([true, false, true, false])]
      ])
    )!
    expect(a.layerSwa).toEqual([true, false, true, false])
  })

  it('gpt-oss: every other layer is SWA', async () => {
    const a = ggufArchInfo(
      await metaOnly([
        ['general.architecture', str('gpt-oss')],
        ['gpt-oss.block_count', u32(4)],
        ['gpt-oss.embedding_length', u32(64)],
        ['gpt-oss.attention.head_count', u32(8)],
        ['gpt-oss.attention.head_count_kv', u32(2)],
        ['gpt-oss.attention.sliding_window', u32(128)]
      ])
    )!
    expect(a.layerSwa).toEqual([true, false, true, false])
  })

  it('MLA (deepseek2): compressed KV = kv_lora_rank + rope', async () => {
    const a = ggufArchInfo(
      await metaOnly([
        ['general.architecture', str('deepseek2')],
        ['deepseek2.block_count', u32(3)],
        ['deepseek2.embedding_length', u32(7168)],
        ['deepseek2.attention.head_count', u32(128)],
        ['deepseek2.attention.head_count_kv', u32(1)],
        ['deepseek2.attention.key_length', u32(576)],
        ['deepseek2.attention.value_length', u32(512)],
        ['deepseek2.attention.key_length_mla', u32(192)],
        ['deepseek2.attention.value_length_mla', u32(128)],
        ['deepseek2.attention.kv_lora_rank', u32(512)],
        ['deepseek2.rope.dimension_count', u32(64)]
      ])
    )!
    expect(a.mlaKvDim).toBe(576)
  })

  it('hybrid qwen3next: full_attention_interval marks recurrent layers and SSM state', async () => {
    const a = ggufArchInfo(
      await metaOnly([
        ['general.architecture', str('qwen3next')],
        ['qwen3next.block_count', u32(8)],
        ['qwen3next.embedding_length', u32(2048)],
        ['qwen3next.attention.head_count', u32(16)],
        ['qwen3next.attention.head_count_kv', u32(2)],
        ['qwen3next.attention.key_length', u32(256)],
        ['qwen3next.attention.value_length', u32(256)],
        ['qwen3next.full_attention_interval', u32(4)],
        ['qwen3next.ssm.conv_kernel', u32(4)],
        ['qwen3next.ssm.state_size', u32(128)],
        ['qwen3next.ssm.group_count', u32(16)],
        ['qwen3next.ssm.inner_size', u32(4096)]
      ])
    )!
    expect(a.layerRecurrent).toEqual([true, true, true, false, true, true, true, false])
    expect(a.recurrentLayers).toBe(6)
    expect(a.layerKvHeads).toEqual([0, 0, 0, 2, 0, 0, 0, 2])
    expect(a.recurrentStateElems).toBe(3 * (4096 + 2 * 16 * 128) + 128 * 4096)
  })

  it('jamba-style hybrid: zero KV heads = recurrent', async () => {
    const a = ggufArchInfo(
      await metaOnly([
        ['general.architecture', str('jamba')],
        ['jamba.block_count', u32(4)],
        ['jamba.embedding_length', u32(64)],
        ['jamba.attention.head_count', u32(8)],
        ['jamba.attention.head_count_kv', arrI32([0, 0, 0, 8])],
        ['jamba.ssm.conv_kernel', u32(4)],
        ['jamba.ssm.state_size', u32(16)],
        ['jamba.ssm.inner_size', u32(128)]
      ])
    )!
    expect(a.recurrentLayers).toBe(3)
    expect(a.nHeadKv).toBe(8)
  })

  it('MTP/nextn layers are excluded from nLayers', async () => {
    const a = ggufArchInfo(await parse(moeLike().bufs[0]!))!
    expect(a.nLayers).toBe(3)
    expect(a.nextnLayers).toBe(1)
    expect(a.nExperts).toBe(8)
    expect(a.nExpertsUsed).toBe(2)
    expect(a.nFfExp).toBe(128)
  })
})

describe('tensor classification', () => {
  it('buckets by name', () => {
    expect(classifyLayerTensor('attn_q.weight')).toBe('attn')
    expect(classifyLayerTensor('attn_norm.weight')).toBe('norm')
    expect(classifyLayerTensor('attn_q_norm.weight')).toBe('norm')
    expect(classifyLayerTensor('ffn_gate_exps.weight')).toBe('experts')
    expect(classifyLayerTensor('ffn_gate_up_exps.weight')).toBe('experts')
    expect(classifyLayerTensor('ffn_down_exps.bias')).toBe('experts')
    expect(classifyLayerTensor('exp_probs_b.bias')).toBe('experts')
    expect(classifyLayerTensor('ffn_up_shexp.weight')).toBe('sharedExperts')
    expect(classifyLayerTensor('ffn_gate_inp.weight')).toBe('ffn')
    expect(classifyLayerTensor('ffn_down.weight')).toBe('ffn')
    expect(classifyLayerTensor('ssm_in.weight')).toBe('attn')
    expect(classifyLayerTensor('time_mix_key.weight')).toBe('attn')
    expect(classifyLayerTensor('channel_mix_value.weight')).toBe('ffn')
  })

  it('dense model with tied embeddings', async () => {
    const d = describeGguf(await parse(gemmaLike().buf), 'gemma-3-test-Q4_K_M.gguf')
    const t = d.tensors
    expect(t.layers).toHaveLength(6)
    expect(t.tokenEmbd).toBe(N_VOCAB * (N_EMBD / 32) * 34)
    expect(t.tiedOutput).toBe(true)
    expect(t.output).toBe(t.tokenEmbd)
    const l1 = t.layers[1]!
    expect(l1.attn).toBe(64 * 144 + 32 * 144 + 32 * 210 + N_EMBD * 2 * 34)
    expect(l1.ffn).toBe(512 * 144 * 2 + N_EMBD * 2 * 210)
    expect(l1.norm).toBe(N_EMBD * 4 * 2 + 16 * 4)
    expect(l1.experts).toBe(0)
    expect(t.other).toBeGreaterThan(0) // output_norm + rope_freqs
    expect(t.maxTensor?.ffn).toBe(N_EMBD * 2 * 210)
    expect(d.quant).toBe('Q4_K_M')
    expect(d.isMoe).toBe(false)
    expect(d.isEmbedding).toBe(false)
    expect(d.chatTemplate).toContain('messages')
    expect(d.paramsLabel).toMatch(/^\d+(\.\d)?[KM]$/)
  })

  it('MoE: experts, shared experts, router, MTP, active params', async () => {
    const d = describeGguf(await parse(moeLike().bufs[0]!), 'GLM-test.gguf')
    const l0 = d.tensors.layers[0]!
    const exps = 2 * (N_EMBD / 256) * 144 * 128 * 8 + (128 / 32) * 34 * N_EMBD * 8
    expect(l0.experts).toBe(exps)
    expect(l0.sharedExperts).toBe(2 * 128 * 144 + N_EMBD * 4 * 34)
    expect(l0.ffn).toBe(N_EMBD * 8 * 4) // router f32
    expect(d.tensors.mtp).toBeGreaterThan(0)
    expect(d.tensors.layers).toHaveLength(3)
    expect(d.tensors.tiedOutput).toBeUndefined()
    expect(d.isMoe).toBe(true)
    expect(d.tensors.nParamsActive).toBeLessThan(d.tensors.nParams!)
    expect(d.paramsLabel).toContain('-A')
    // имени кванта нет — берём самый тяжёлый тип
    expect(d.quant).toBe('Q4_K')
  })

  it('detects mmproj and embedding models', async () => {
    const m = describeGguf(await parse(mmprojLike()), 'mmproj-model-f16.gguf')
    expect(m.isMmproj).toBe(true)
    expect(m.mmprojHasVision).toBe(true)
    expect(m.arch).toBeUndefined()

    const emb = describeGguf(
      await metaOnly([
        ['general.architecture', str('nomic-bert')],
        ['nomic-bert.block_count', u32(2)],
        ['nomic-bert.embedding_length', u32(64)],
        ['nomic-bert.attention.head_count', u32(4)],
        ['nomic-bert.pooling_type', u32(1)],
        ['nomic-bert.attention.layer_norm_epsilon', f32(1e-12)]
      ]),
      'nomic-embed-text-v1.5.f16.gguf'
    )
    expect(emb.isEmbedding).toBe(true)
    expect(emb.arch?.layerKvHeads).toEqual([0, 0])
    expect(emb.quant).toBe('F16')

    const qwenEmb = describeGguf(
      await metaOnly([
        ['general.architecture', str('qwen3')],
        ['qwen3.block_count', u32(2)],
        ['qwen3.embedding_length', u32(64)],
        ['qwen3.attention.head_count', u32(4)],
        ['qwen3.pooling_type', u32(3)]
      ]),
      'Qwen3-Embedding-0.6B-Q8_0.gguf'
    )
    expect(qwenEmb.isEmbedding).toBe(true)
  })
})

describe('labels', () => {
  it('quant from file name', () => {
    expect(quantFromFileName('Qwen3-30B-A3B-UD-Q4_K_XL.gguf')).toBe('UD-Q4_K_XL')
    expect(quantFromFileName('Meta-Llama-3.1-8B-Instruct-Q4_K_M.gguf')).toBe('Q4_K_M')
    expect(quantFromFileName('gemma-3-27b-it-IQ4_XS-00001-of-00002.gguf')).toBe('IQ4_XS')
    expect(quantFromFileName('model.i1-Q6_K.gguf')).toBe('Q6_K')
    expect(quantFromFileName('gpt-oss-20b-mxfp4.gguf')).toBe('MXFP4')
    expect(quantFromFileName('Qwen2.5-7B-Instruct-bf16.gguf')).toBe('BF16')
    expect(quantFromFileName('DeepSeek-V3-IQ4_KS.gguf')).toBe('IQ4_KS')
    expect(quantFromFileName('Qwen3-8B-Q8_0.gguf')).toBe('Q8_0')
    expect(quantFromFileName('Qwen3-8B.gguf')).toBeUndefined()
  })

  it('file_type and param formatting', () => {
    expect(ftypeLabel(15)).toBe('Q4_K_M')
    expect(ftypeLabel(15 | 1024)).toBe('Q4_K_M')
    expect(ftypeLabel(30)).toBe('IQ4_XS')
    expect(ftypeLabel(145)).toBe('IQ4_KS')
    expect(formatParamCount(7.62e9)).toBe('7.6B')
    expect(formatParamCount(8.03e9)).toBe('8B')
    expect(formatParamCount(30.5e9)).toBe('31B')
    expect(formatParamCount(596e6)).toBe('596M')
  })
})
