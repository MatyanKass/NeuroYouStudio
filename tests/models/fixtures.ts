// Синтетические модели GGUF для тестов.
import {
  GT,
  arrF32,
  arrI32,
  arrStr,
  bool,
  f32,
  str,
  u32,
  writeGguf,
  type WTensor,
  type WValue
} from './helpers/gguf-writer'

export const N_VOCAB = 1000
export const N_EMBD = 256

export function tokenizerKv(n = N_VOCAB): Array<[string, WValue]> {
  const tokens = Array.from({ length: n }, (_, i) => `tok_${i}`)
  return [
    ['tokenizer.ggml.model', str('gpt2')],
    ['tokenizer.ggml.tokens', arrStr(tokens)],
    ['tokenizer.ggml.scores', arrF32(new Array<number>(n).fill(0))],
    ['tokenizer.ggml.token_type', arrI32(new Array<number>(n).fill(1))],
    ['tokenizer.ggml.merges', arrStr(Array.from({ length: n }, (_, i) => `a${i} b${i}`))]
  ]
}

/** Gemma3-подобная: 6 слоёв, SWA (5 из 6), head_count_kv массивом, tied-эмбеддинги, неизвестный тип. */
export function gemmaLike(): { buf: Buffer; tensors: WTensor[] } {
  const L = 6
  const tensors: WTensor[] = [{ name: 'token_embd.weight', dims: [N_EMBD, N_VOCAB], type: GT.Q8_0 }]
  for (let i = 0; i < L; i++) {
    tensors.push(
      { name: `blk.${i}.attn_norm.weight`, dims: [N_EMBD], type: GT.F32 },
      // неизвестный тип 777 — размер берётся по смещениям
      { name: `blk.${i}.attn_q.weight`, dims: [N_EMBD, 64], type: i === 0 ? 777 : GT.Q4_K, size: i === 0 ? 5000 : undefined },
      { name: `blk.${i}.attn_k.weight`, dims: [N_EMBD, 32], type: GT.Q4_K },
      { name: `blk.${i}.attn_v.weight`, dims: [N_EMBD, 32], type: GT.Q6_K },
      { name: `blk.${i}.attn_q_norm.weight`, dims: [16], type: GT.F32 },
      { name: `blk.${i}.attn_output.weight`, dims: [64, N_EMBD], type: GT.Q8_0 },
      { name: `blk.${i}.ffn_norm.weight`, dims: [N_EMBD], type: GT.F32 },
      { name: `blk.${i}.ffn_gate.weight`, dims: [N_EMBD, 512], type: GT.Q4_K },
      { name: `blk.${i}.ffn_up.weight`, dims: [N_EMBD, 512], type: GT.Q4_K },
      { name: `blk.${i}.ffn_down.weight`, dims: [512, N_EMBD], type: GT.Q6_K }
    )
  }
  tensors.push({ name: 'output_norm.weight', dims: [N_EMBD], type: GT.F32 })
  // последний тензор неизвестного типа: размер — до конца файла
  tensors.push({ name: 'rope_freqs.weight', dims: [32], type: 888, size: 96 })
  const buf = writeGguf({
    kv: [
      ['general.architecture', str('gemma3')],
      ['general.name', str('Test Gemma')],
      ['general.file_type', u32(15)],
      ['gemma3.block_count', u32(L)],
      ['gemma3.context_length', u32(32768)],
      ['gemma3.embedding_length', u32(N_EMBD)],
      ['gemma3.feed_forward_length', u32(512)],
      ['gemma3.attention.head_count', u32(4)],
      ['gemma3.attention.head_count_kv', arrI32([2, 2, 2, 2, 2, 1])],
      ['gemma3.attention.key_length', u32(16)],
      ['gemma3.attention.value_length', u32(16)],
      ['gemma3.attention.sliding_window', u32(512)],
      ['gemma3.attention.layer_norm_rms_epsilon', f32(1e-6)],
      ['tokenizer.chat_template', str('{% for m in messages %}{{ m.content }}{% endfor %}')],
      ['tokenizer.ggml.add_bos_token', bool(true)],
      ...tokenizerKv()
    ],
    tensors
  })
  return { buf, tensors }
}

/** MoE с общими экспертами и одним MTP-слоем (block_count = 4, nextn = 1). */
export function moeLike(splitAt?: number): { bufs: Buffer[]; tensors: WTensor[] } {
  const nAll = 4
  const E = 8
  const tensors: WTensor[] = [{ name: 'token_embd.weight', dims: [N_EMBD, N_VOCAB], type: GT.Q8_0 }]
  for (let i = 0; i < nAll; i++) {
    tensors.push(
      { name: `blk.${i}.attn_norm.weight`, dims: [N_EMBD], type: GT.F32 },
      { name: `blk.${i}.attn_q.weight`, dims: [N_EMBD, N_EMBD], type: GT.Q4_K },
      { name: `blk.${i}.attn_k.weight`, dims: [N_EMBD, 64], type: GT.Q4_K },
      { name: `blk.${i}.attn_v.weight`, dims: [N_EMBD, 64], type: GT.Q4_K },
      { name: `blk.${i}.attn_output.weight`, dims: [N_EMBD, N_EMBD], type: GT.Q4_K },
      { name: `blk.${i}.ffn_gate_inp.weight`, dims: [N_EMBD, E], type: GT.F32 },
      { name: `blk.${i}.ffn_gate_exps.weight`, dims: [N_EMBD, 128, E], type: GT.Q4_K },
      { name: `blk.${i}.ffn_up_exps.weight`, dims: [N_EMBD, 128, E], type: GT.Q4_K },
      { name: `blk.${i}.ffn_down_exps.weight`, dims: [128, N_EMBD, E], type: GT.Q8_0 },
      { name: `blk.${i}.ffn_gate_shexp.weight`, dims: [N_EMBD, 128], type: GT.Q4_K },
      { name: `blk.${i}.ffn_up_shexp.weight`, dims: [N_EMBD, 128], type: GT.Q4_K },
      { name: `blk.${i}.ffn_down_shexp.weight`, dims: [128, N_EMBD], type: GT.Q8_0 }
    )
  }
  tensors.push({ name: 'blk.3.nextn.eh_proj.weight', dims: [512, N_EMBD], type: GT.Q8_0 })
  tensors.push({ name: 'output_norm.weight', dims: [N_EMBD], type: GT.F32 })
  tensors.push({ name: 'output.weight', dims: [N_EMBD, N_VOCAB], type: GT.Q6_K })
  const kv: Array<[string, WValue]> = [
    ['general.architecture', str('glm4moe')],
    ['general.name', str('Test MoE')],
    ['glm4moe.block_count', u32(nAll)],
    ['glm4moe.nextn_predict_layers', u32(1)],
    ['glm4moe.context_length', u32(131072)],
    ['glm4moe.embedding_length', u32(N_EMBD)],
    ['glm4moe.feed_forward_length', u32(1024)],
    ['glm4moe.expert_feed_forward_length', u32(128)],
    ['glm4moe.expert_count', u32(E)],
    ['glm4moe.expert_used_count', u32(2)],
    ['glm4moe.attention.head_count', u32(8)],
    ['glm4moe.attention.head_count_kv', u32(2)],
    ['glm4moe.attention.key_length', u32(32)],
    ['glm4moe.attention.value_length', u32(32)],
    ...tokenizerKv(),
    ['tokenizer.chat_template', str('{{ x }}')]
  ]
  if (splitAt === undefined) return { bufs: [writeGguf({ kv, tensors })], tensors }
  const a = tensors.slice(0, splitAt)
  const b = tensors.slice(splitAt)
  const first = writeGguf({
    kv: [...kv, ['split.no', { t: 'u16', v: 0 }], ['split.count', { t: 'u16', v: 2 }], ['split.tensors.count', { t: 'i32', v: tensors.length }]],
    tensors: a
  })
  const second = writeGguf({
    kv: [['split.no', { t: 'u16', v: 1 }], ['split.count', { t: 'u16', v: 2 }], ['split.tensors.count', { t: 'i32', v: tensors.length }]],
    tensors: b
  })
  return { bufs: [first, second], tensors }
}

/** mmproj (clip) с vision-энкодером. */
export function mmprojLike(): Buffer {
  return writeGguf({
    kv: [
      ['general.architecture', str('clip')],
      ['general.type', str('mmproj')],
      ['clip.has_vision_encoder', bool(true)],
      ['clip.projector_type', str('gemma3')]
    ],
    tensors: [
      { name: 'v.blk.0.attn_q.weight', dims: [64, 64], type: GT.F16 },
      { name: 'mm.input_projection.weight', dims: [64, N_EMBD], type: GT.F16 }
    ]
  })
}
