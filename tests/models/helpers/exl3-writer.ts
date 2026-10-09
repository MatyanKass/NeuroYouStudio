// Тестовые папки EXL3: config.json + safetensors с нулевыми данными.
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** safetensors с нулевыми данными заданных размеров. */
export function safetensors(tensors: Record<string, number>, metadata?: Record<string, string>): Buffer {
  const header: Record<string, unknown> = {}
  if (metadata) header.__metadata__ = metadata
  let off = 0
  for (const [name, size] of Object.entries(tensors)) {
    header[name] = { dtype: 'I16', shape: [size / 2], data_offsets: [off, off + size] }
    off += size
  }
  const json = Buffer.from(JSON.stringify(header), 'utf8')
  const len = Buffer.alloc(8)
  len.writeBigUInt64LE(BigInt(json.length))
  return Buffer.concat([len, json, Buffer.alloc(off)])
}

export async function writeExl3Folder(dir: string, opts: { vision?: boolean; tied?: boolean } = {}): Promise<void> {
  await mkdir(dir, { recursive: true })
  const text = {
    model_type: 'qwen3_moe',
    num_hidden_layers: 4,
    hidden_size: 256,
    num_attention_heads: 8,
    num_key_value_heads: 2,
    head_dim: 32,
    intermediate_size: 512,
    moe_intermediate_size: 64,
    num_experts: 8,
    num_experts_per_tok: 2,
    max_position_embeddings: 40960,
    vocab_size: 1000,
    sliding_window: 128,
    layer_types: ['sliding_attention', 'full_attention', 'sliding_attention', 'full_attention']
  }
  const config = opts.vision
    ? { architectures: ['Qwen3MoeVL'], model_type: 'qwen3_vl_moe', text_config: text, vision_config: { depth: 2 } }
    : { architectures: ['Qwen3MoeForCausalLM'], ...text }
  await writeFile(
    join(dir, 'config.json'),
    JSON.stringify({ ...config, quantization_config: { quant_method: 'exl3', version: '0.0.6', bits: 4.0, head_bits: 6 } })
  )
  await writeFile(join(dir, 'tokenizer_config.json'), JSON.stringify({ chat_template: '{{ messages }}' }))
  const t: Record<string, number> = { 'model.embed_tokens.weight': 1000 * 256 * 2, 'model.norm.weight': 512 }
  if (!opts.tied) t['lm_head.trellis'] = 1000 * 256 * 0.75
  for (let i = 0; i < 4; i++) {
    t[`model.layers.${i}.input_layernorm.weight`] = 512
    t[`model.layers.${i}.self_attn.q_proj.trellis`] = 256 * 256 / 2
    t[`model.layers.${i}.self_attn.k_proj.trellis`] = 256 * 64 / 2
    t[`model.layers.${i}.self_attn.q_norm.weight`] = 64
    t[`model.layers.${i}.mlp.gate.weight`] = 256 * 8 * 2
    for (let e = 0; e < 8; e++) t[`model.layers.${i}.mlp.experts.${e}.down_proj.trellis`] = 256 * 64 / 2
    t[`model.layers.${i}.mlp.shared_expert.up_proj.trellis`] = 256 * 64 / 2
  }
  if (opts.vision) {
    t['model.visual.blocks.0.attn.qkv.weight'] = 4096
    t['model.visual.merger.mlp.0.weight'] = 2048
  }
  const names = Object.keys(t)
  const half = Math.floor(names.length / 2)
  await writeFile(join(dir, 'model-00001-of-00002.safetensors'), safetensors(Object.fromEntries(names.slice(0, half).map((n) => [n, t[n]!]))))
  await writeFile(join(dir, 'model-00002-of-00002.safetensors'), safetensors(Object.fromEntries(names.slice(half).map((n) => [n, t[n]!]))))
}

