import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  classifyExl3Tensor,
  exl3ArchInfo,
  isExl3Dir,
  paramsLabelFromName,
  readExl3Model,
  readSafetensorsHeader
} from '../../src/main/models/exl3'
import { writeExl3Folder } from './helpers/exl3-writer'

let dir: string
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'nys-exl3-'))
})
afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('EXL3', () => {
  it('classifies HF tensor names', () => {
    expect(classifyExl3Tensor('model.layers.3.self_attn.q_proj.trellis')).toEqual({ kind: 'layer', layer: 3, bucket: 'attn' })
    expect(classifyExl3Tensor('model.layers.3.post_attention_layernorm.weight')).toMatchObject({ bucket: 'norm' })
    expect(classifyExl3Tensor('model.layers.0.mlp.experts.17.up_proj.suh')).toMatchObject({ bucket: 'experts' })
    expect(classifyExl3Tensor('model.layers.0.block_sparse_moe.experts.1.w1.trellis')).toMatchObject({ bucket: 'experts' })
    expect(classifyExl3Tensor('model.layers.0.mlp.shared_expert.up_proj.trellis')).toMatchObject({ bucket: 'sharedExperts' })
    expect(classifyExl3Tensor('model.layers.0.mlp.gate.weight')).toMatchObject({ bucket: 'ffn' })
    expect(classifyExl3Tensor('model.layers.0.mlp.down_proj.trellis')).toMatchObject({ bucket: 'ffn' })
    expect(classifyExl3Tensor('model.layers.0.linear_attn.in_proj_qkvz.trellis')).toMatchObject({ bucket: 'attn' })
    expect(classifyExl3Tensor('model.language_model.layers.5.self_attn.o_proj.trellis')).toMatchObject({ layer: 5 })
    expect(classifyExl3Tensor('model.embed_tokens.weight')).toEqual({ kind: 'tokenEmbd' })
    expect(classifyExl3Tensor('lm_head.trellis')).toEqual({ kind: 'output' })
    expect(classifyExl3Tensor('model.visual.blocks.0.attn.qkv.weight')).toEqual({ kind: 'vision' })
    expect(classifyExl3Tensor('vision_tower.vision_model.encoder.layers.0.mlp.fc1.weight')).toEqual({ kind: 'vision' })
  })

  it('arch info from config (layer_types)', () => {
    const a = exl3ArchInfo({
      model_type: 'qwen3_next',
      num_hidden_layers: 4,
      hidden_size: 2048,
      num_attention_heads: 16,
      num_key_value_heads: 2,
      head_dim: 256,
      layer_types: ['linear_attention', 'linear_attention', 'linear_attention', 'full_attention'],
      linear_num_key_heads: 16,
      linear_num_value_heads: 32,
      linear_key_head_dim: 128,
      linear_value_head_dim: 128,
      vocab_size: 151936
    })!
    expect(a.layerRecurrent).toEqual([true, true, true, false])
    expect(a.layerKvHeads).toEqual([0, 0, 0, 2])
    expect(a.recurrentStateElems).toBeGreaterThan(0)
    const g = exl3ArchInfo({ model_type: 'gemma3_text', num_hidden_layers: 6, hidden_size: 64, num_attention_heads: 4, sliding_window: 512 })!
    expect(g.swaLayers).toBe(5)
  })

  it('reads a model folder', async () => {
    const d = join(dir, 'pub', 'Qwen3-30B-A3B-exl3__4.0bpw')
    await writeExl3Folder(d)
    expect(await isExl3Dir(d)).toBe(true)
    const hdr = await readSafetensorsHeader(join(d, 'model-00001-of-00002.safetensors'))
    expect(Object.keys(hdr).length).toBeGreaterThan(5)
    const m = await readExl3Model(d, 'Qwen3-30B-A3B-exl3')
    expect(m.bpw).toBe(4)
    expect(m.quant).toBe('4.0bpw')
    expect(m.paramsLabel).toBe('30B-A3B')
    expect(m.isMoe).toBe(true)
    expect(m.vision).toBe(false)
    expect(m.chatTemplate).toBe('{{ messages }}')
    expect(m.arch?.nLayers).toBe(4)
    expect(m.arch?.layerSwa).toEqual([true, false, true, false])
    const l = m.tensors.layers[0]!
    expect(l.experts).toBe(8 * 256 * 64 / 2)
    expect(l.sharedExperts).toBe(256 * 64 / 2)
    expect(l.ffn).toBe(256 * 8 * 2)
    expect(l.norm).toBe(512 + 64)
    expect(m.tensors.tokenEmbd).toBe(1000 * 256 * 2)
    expect(m.tensors.output).toBe(1000 * 256 * 0.75)
    expect(m.files.length).toBe(4)
  })

  it('vision tower and tied embeddings', async () => {
    const d = join(dir, 'pub', 'vl__main')
    await writeExl3Folder(d, { vision: true, tied: true })
    const m = await readExl3Model(d, 'vl')
    expect(m.vision).toBe(true)
    expect(m.tensors.vision).toBe(4096 + 2048)
    expect(m.tensors.tiedOutput).toBe(true)
    expect(m.tensors.output).toBe(m.tensors.tokenEmbd)
    expect(m.arch?.nLayers).toBe(4)
  })

  it('params label from name', () => {
    expect(paramsLabelFromName('Llama-3.1-8B-Instruct-exl3')).toBe('8B')
    expect(paramsLabelFromName('Qwen3-30B-A3B-exl3')).toBe('30B-A3B')
    expect(paramsLabelFromName('Qwen3-0.6B-exl3')).toBe('0.6B')
    expect(paramsLabelFromName('Mixtral-8x7B-v0.1')).toBe('8x7B')
    expect(paramsLabelFromName('SmolLM2-360M')).toBe('360M')
    expect(paramsLabelFromName('model')).toBeUndefined()
  })
})
