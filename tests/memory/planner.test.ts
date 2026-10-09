import { describe, expect, it } from 'vitest'
import { DEFAULT_LOAD_CONFIG, DEFAULT_MEMORY_LAYOUT, type LoadConfig, type MemoryLayout } from '@shared/config'
import type { HardwareInfo, LocalModel, ModelArchInfo, ModelTensorStats } from '@shared/types'
import { estimateFitForFile, kvBytesPerToken, kvCacheBytes, planMemory } from '../../src/main/memory/planner'
import { kvGeometry } from '../../src/main/memory/kv'

const MiB = 1024 * 1024
const GiB = 1024 * MiB

// ---------- Модели ----------

const q4k = (n: number): number => (n / 256) * 144
const q6k = (n: number): number => (n / 256) * 210

/** Llama-3-8B Q4_K_M (размеры тензоров как в реальном файле). */
function llama8b(): LocalModel {
  const arch: ModelArchInfo = {
    arch: 'llama',
    nLayers: 32,
    nEmbd: 4096,
    nHead: 32,
    nHeadKv: 8,
    headDimK: 128,
    headDimV: 128,
    contextLengthMax: 131072,
    nExperts: 0,
    nExpertsUsed: 0,
    slidingWindow: 0,
    swaLayers: 0,
    mlaKvDim: 0,
    recurrentLayers: 0,
    vocabSize: 128256,
    nFf: 14336
  }
  const layer = {
    attn: q4k(4096 * 4096) * 2 + q4k(4096 * 1024) + q6k(4096 * 1024),
    ffn: q4k(4096 * 14336) * 2 + q6k(14336 * 4096),
    experts: 0,
    sharedExperts: 0,
    norm: 4096 * 4 * 2
  }
  const tensors: ModelTensorStats = {
    tokenEmbd: q4k(128256 * 4096),
    output: q6k(128256 * 4096),
    other: 4096 * 4,
    layers: Array.from({ length: 32 }, () => ({ ...layer })),
    maxTensor: { attn: q4k(4096 * 4096), ffn: q6k(14336 * 4096), experts: 0, sharedExperts: 0 }
  }
  const size = tensors.tokenEmbd + tensors.output + tensors.other + 32 * (layer.attn + layer.ffn + layer.norm)
  return base({ arch, tensors, sizeBytes: size, name: 'Meta-Llama-3-8B-Instruct-Q4_K_M' })
}

/** Qwen3-30B-A3B Q4_K_M: 48 слоёв, 128 экспертов (8 активных). */
function qwen30bA3b(): LocalModel {
  const L = 48
  const arch: ModelArchInfo = {
    arch: 'qwen3moe',
    nLayers: L,
    nEmbd: 2048,
    nHead: 32,
    nHeadKv: 4,
    headDimK: 128,
    headDimV: 128,
    contextLengthMax: 40960,
    nExperts: 128,
    nExpertsUsed: 8,
    slidingWindow: 0,
    swaLayers: 0,
    mlaKvDim: 0,
    recurrentLayers: 0,
    vocabSize: 151936,
    nFf: 6144,
    nFfExp: 768
  }
  const experts = 128 * (q4k(2048 * 768) * 2 + q6k(768 * 2048))
  const layer = {
    attn: q4k(2048 * 4096) * 2 + q4k(2048 * 512) + q6k(2048 * 512),
    ffn: 2048 * 128 * 4,
    experts,
    sharedExperts: 0,
    norm: 2048 * 4 * 2
  }
  const tensors: ModelTensorStats = {
    tokenEmbd: q4k(151936 * 2048),
    output: q6k(151936 * 2048),
    other: 2048 * 4,
    layers: Array.from({ length: L }, () => ({ ...layer })),
    maxTensor: { attn: q4k(2048 * 4096), ffn: 2048 * 128 * 4, experts: 128 * q6k(768 * 2048), sharedExperts: 0 }
  }
  const size = tensors.tokenEmbd + tensors.output + L * (layer.attn + layer.ffn + layer.experts + layer.norm)
  return base({ arch, tensors, sizeBytes: size, isMoe: true, name: 'Qwen3-30B-A3B-Q4_K_M' })
}

function base(p: Partial<LocalModel>): LocalModel {
  return {
    id: 'x',
    format: 'gguf',
    path: 'x.gguf',
    files: [],
    sizeBytes: 0,
    publisher: '',
    repo: '',
    name: '',
    quant: 'Q4_K_M',
    paramsLabel: '',
    isMoe: false,
    vision: false,
    isEmbedding: false,
    ...p
  }
}

// ---------- Железо ----------

const rtx5060ti: HardwareInfo = {
  gpus: [{ index: 0, name: 'RTX 5060 Ti', vramTotalMiB: 16311, vramFreeMiB: 15400, driverVersion: '590', computeCap: '12.0' }],
  ramTotalMiB: 32768,
  ramFreeMiB: 24000,
  cpuName: 'x',
  cpuCores: 8,
  cpuThreads: 16,
  avx2: true,
  avx512: false
}
const gtx1660: HardwareInfo = {
  ...rtx5060ti,
  gpus: [{ index: 0, name: 'GTX 1660', vramTotalMiB: 6144, vramFreeMiB: 5300, driverVersion: '580', computeCap: '7.5' }]
}
const noGpu: HardwareInfo = { ...rtx5060ti, gpus: [] }

const load = (memory: Partial<MemoryLayout> = {}, rest: Partial<LoadConfig> = {}): LoadConfig => ({
  ...DEFAULT_LOAD_CONFIG,
  ...rest,
  memory: { ...DEFAULT_MEMORY_LAYOUT, ...memory }
})
const comp = (p: ReturnType<typeof planMemory>, id: string) => p.components.find((c) => c.id === id)!

// ---------- KV ----------

describe('KV cache size', () => {
  it('Llama-3-8B: 128 KiB per token, 8192 ctx = 1 GiB (f16)', () => {
    const a = llama8b().arch!
    expect(kvBytesPerToken(a)).toBe(128 * 1024)
    expect(kvCacheBytes(a, 8192, 'f16', 'f16')).toBe(GiB)
    expect(kvCacheBytes(a, 8192, 'q8_0', 'q8_0')).toBe((GiB / 2) * (34 / 32))
    expect(kvCacheBytes(a, 8192, 'q4_0', 'f16')).toBe(GiB / 2 + (GiB / 4) * (18 / 32))
    // контекст выравнивается до 256
    expect(kvCacheBytes(a, 8000, 'f16', 'f16')).toBe(GiB)
  })

  it('SWA layers keep only window + ubatch cells', () => {
    const a: ModelArchInfo = {
      ...llama8b().arch!,
      nLayers: 6,
      slidingWindow: 1024,
      swaLayers: 5,
      layerSwa: [true, true, true, true, true, false]
    }
    const geo = kvGeometry(a, 32768, { nUbatch: 512 })
    expect(geo.cellsFull).toBe(32768)
    expect(geo.cellsSwa).toBe(1536)
    const perCell = 8 * 128 * 2 * 2
    expect(kvCacheBytes(a, 32768, 'f16', 'f16', { nUbatch: 512 })).toBe(perCell * (32768 + 5 * 1536))
    expect(kvCacheBytes(a, 32768, 'f16', 'f16', { nUbatch: 512, swaFull: true })).toBe(perCell * 6 * 32768)
  })

  it('MLA: (kv_lora_rank + rope) per token per layer, no separate V', () => {
    const a: ModelArchInfo = { ...llama8b().arch!, nLayers: 61, nHeadKv: 1, mlaKvDim: 576 }
    expect(kvCacheBytes(a, 4096, 'f16', 'f16')).toBe(61 * 4096 * 576 * 2)
  })

  it('recurrent layers: fixed state instead of KV', () => {
    const a: ModelArchInfo = {
      ...llama8b().arch!,
      nLayers: 4,
      recurrentLayers: 3,
      layerRecurrent: [true, true, true, false],
      layerKvHeads: [0, 0, 0, 8],
      recurrentStateElems: 1000
    }
    expect(kvCacheBytes(a, 1024, 'f16', 'f16')).toBe(1024 * 8 * 128 * 4 + 3 * 1000 * 4)
  })
})

// ---------- Буферы вычислений (калибровка по логам llama.cpp) ----------

describe('compute buffer estimate', () => {
  it('Llama-3-8B, ctx 8192, ub 512: ≈258 MiB with FA, ≈560 MiB without', () => {
    const on = planMemory(llama8b(), load({}, { flashAttention: 'on' }), rtx5060ti, 'llamacpp')
    const off = planMemory(llama8b(), load({}, { flashAttention: 'off' }), rtx5060ti, 'llamacpp')
    expect(comp(on, 'compute').vramBytes / MiB).toBeGreaterThan(258.5 * 0.9)
    expect(comp(on, 'compute').vramBytes / MiB).toBeLessThan(258.5 * 1.1)
    expect(comp(off, 'compute').vramBytes / MiB).toBeGreaterThan(560 * 0.9)
    expect(comp(off, 'compute').vramBytes / MiB).toBeLessThan(560 * 1.1)
    expect(comp(on, 'compute').ramBytes / MiB).toBeGreaterThan(20)
    expect(comp(on, 'compute').ramBytes / MiB).toBeLessThan(30)
  })
})

// ---------- Профили ----------

describe('planMemory: auto profiles', () => {
  it('speed: 8B fits fully on 16 GB', () => {
    const p = planMemory(llama8b(), load(), rtx5060ti, 'llamacpp')
    expect(p.fit).toBe('full')
    expect(p.resolved.gpuLayers).toBe(-1)
    expect(p.resolved.kvCache).toBe('vram')
    expect(comp(p, 'kv').vramBytes).toBe(GiB)
    expect(comp(p, 'embd').ramBytes).toBeGreaterThan(0)
    expect(comp(p, 'embd').vramBytes).toBe(0)
    expect(comp(p, 'other').vramBytes).toBeGreaterThanOrEqual(300 * MiB)
    expect(p.vramBytes).toBeLessThan(p.vramAvailableBytes)
    expect(p.args).toEqual([])
    expect(p.nLayers).toBe(32)
    expect(p.warnings).toEqual([])
    const sum = p.components.reduce((s, c) => s + c.vramBytes, 0)
    expect(sum).toBe(p.vramBytes)
  })

  it('userSplit: KV goes to RAM, weights + compute stay in VRAM', () => {
    const p = planMemory(llama8b(), load({ profile: 'userSplit' }), rtx5060ti, 'llamacpp')
    expect(p.resolved.kvCache).toBe('ram')
    expect(p.resolved.gpuLayers).toBe(-1)
    expect(comp(p, 'kv').ramBytes).toBe(GiB)
    expect(comp(p, 'kv').vramBytes).toBe(0)
    expect(comp(p, 'attn').ramBytes).toBe(0)
    expect(comp(p, 'ffn').ramBytes).toBe(0)
    expect(p.fit).toBe('partial')
    expect(p.warnings.join(' ')).toMatch(/KV-кэш в RAM/)
  })

  it('MoE overflow moves experts to RAM first (layer by layer)', () => {
    const p = planMemory(qwen30bA3b(), load(), gtx1660, 'llamacpp')
    expect(p.resolved.gpuLayers).toBe(-1)
    expect(p.resolved.expertsCpuLayers).toBeGreaterThan(0)
    expect(p.resolved.kvCache).toBe('vram')
    expect(p.fit).toBe('partial')
    expect(p.vramBytes).toBeLessThanOrEqual(p.vramAvailableBytes)
    expect(comp(p, 'experts').ramBytes).toBeGreaterThan(0)
    expect(comp(p, 'attn').ramBytes).toBe(0)
    // ровно столько слоёв, сколько нужно: на один меньше — уже не влезает
    const k = p.resolved.expertsCpuLayers
    if (k > 1) {
      const fewer = planMemory(qwen30bA3b(), load({ mode: 'manual', expertsCpuLayers: k - 1 }), gtx1660, 'llamacpp')
      expect(fewer.vramBytes).toBeGreaterThan(fewer.vramAvailableBytes)
    }
  })

  it('dense overflow drops whole layers from the front', () => {
    const big = llama8b()
    const p = planMemory(big, load({}, { contextLength: 32768 }), gtx1660, 'llamacpp')
    expect(p.resolved.gpuLayers).toBeGreaterThan(0)
    expect(p.resolved.gpuLayers).toBeLessThan(32)
    expect(p.fit).toBe('partial')
    expect(p.vramBytes).toBeLessThanOrEqual(p.vramAvailableBytes)
    expect(p.warnings.join(' ')).toMatch(/слоёв в RAM/)
  })

  it('longContext: dense FFN leaves VRAM before attention/KV', () => {
    const p = planMemory(llama8b(), load({ profile: 'longContext' }, { contextLength: 16384 }), gtx1660, 'llamacpp')
    expect(p.resolved.kvCache).toBe('vram')
    expect(p.resolved.ffnCpuLayers! > 0 || p.resolved.ffn === 'ram').toBe(true)
    expect(comp(p, 'kv').ramBytes).toBe(0)
    expect(comp(p, 'ffn').ramBytes).toBeGreaterThan(0)
    if (p.resolved.gpuLayers === -1) expect(comp(p, 'attn').ramBytes).toBe(0)
    expect(p.vramBytes).toBeLessThanOrEqual(p.vramAvailableBytes)
  })

  it('saveVram uses at most half of total VRAM', () => {
    const p = planMemory(qwen30bA3b(), load({ profile: 'saveVram' }), rtx5060ti, 'llamacpp')
    expect(p.vramBytes).toBeLessThanOrEqual(0.5 * 16311 * MiB)
    expect(p.resolved.expertsCpuLayers).not.toBe(0)
    const speed = planMemory(qwen30bA3b(), load({ profile: 'speed' }), rtx5060ti, 'llamacpp')
    expect(speed.vramBytes).toBeGreaterThan(p.vramBytes)
  })

  it('no GPU: everything in RAM', () => {
    const p = planMemory(llama8b(), load(), noGpu, 'llamacpp')
    expect(p.fit).toBe('ram')
    expect(p.vramBytes).toBe(0)
    expect(p.resolved.gpuLayers).toBe(0)
    expect(comp(p, 'other').vramBytes).toBe(0)
  })
})

describe('planMemory: manual layout and fit', () => {
  it('manual layout is used as is and never mutated', () => {
    const layout: MemoryLayout = {
      ...DEFAULT_MEMORY_LAYOUT,
      mode: 'manual',
      gpuLayers: 20,
      kvCache: 'ram',
      output: 'ram',
      expertsCpuLayers: 0
    }
    const frozen = structuredClone(layout)
    const l = load(layout)
    const p = planMemory(llama8b(), l, rtx5060ti, 'llamacpp')
    expect(l.memory).toEqual(frozen)
    expect(p.resolved).toEqual(frozen)
    expect(p.resolved).not.toBe(l.memory)
    expect(p.fit).toBe('partial')
    expect(comp(p, 'output').ramBytes).toBeGreaterThan(0)
    const m = llama8b()
    const perLayer = m.tensors!.layers[0]!.attn + m.tensors!.layers[0]!.norm
    expect(comp(p, 'attn').vramBytes).toBeCloseTo(20 * perLayer, -2)
    expect(comp(p, 'kv').ramBytes).toBe(GiB)
    // op-offload: веса слоёв в RAM копируются в VRAM при обработке промпта
    expect(comp(p, 'compute').hint).toMatch(/копируются/)
  })

  it('fit none when nothing fits, with a Russian explanation', () => {
    const huge = qwen30bA3b()
    const tiny: HardwareInfo = { ...gtx1660, ramFreeMiB: 4000 }
    const p = planMemory(huge, load(), tiny, 'llamacpp')
    expect(p.fit).toBe('none')
    expect(p.warnings.join(' ')).toMatch(/Не хватает RAM/)
  })

  it('warns about quantized V-cache without Flash Attention', () => {
    const p = planMemory(
      llama8b(),
      load({}, { flashAttention: 'off', vCacheType: { enabled: true, value: 'q8_0' } }),
      rtx5060ti,
      'llamacpp'
    )
    expect(p.warnings.join(' ')).toMatch(/V-кэш.*Flash Attention/)
  })

  it('tied embeddings on CPU cost nothing extra', () => {
    const m = llama8b()
    m.tensors = { ...m.tensors!, output: m.tensors!.tokenEmbd, tiedOutput: true }
    const p = planMemory(m, load({ mode: 'manual', output: 'ram' }), rtx5060ti, 'llamacpp')
    expect(comp(p, 'output').ramBytes).toBe(m.tensors.other)
    const g = planMemory(m, load({ mode: 'manual', output: 'vram' }), rtx5060ti, 'llamacpp')
    expect(comp(g, 'output').vramBytes).toBe(m.tensors.tokenEmbd + m.tensors.other)
  })

  it('mmproj in VRAM by default, RAM when asked', () => {
    const m = { ...llama8b(), mmprojPath: 'mmproj.gguf', mmprojSizeBytes: 800 * MiB, vision: true }
    const p = planMemory(m, load(), rtx5060ti, 'llamacpp')
    expect(comp(p, 'mmproj').vramBytes).toBeGreaterThan(800 * MiB)
    const r = planMemory(m, load({ mode: 'manual', mmproj: 'ram' }), rtx5060ti, 'llamacpp')
    expect(comp(r, 'mmproj').ramBytes).toBeGreaterThan(800 * MiB)
    expect(comp(r, 'mmproj').vramBytes).toBe(0)
  })

  it('model without metadata gets an approximate plan', () => {
    const m = base({ sizeBytes: 5 * GiB })
    const p = planMemory(m, load(), rtx5060ti, 'llamacpp')
    expect(p.fit).toBe('full')
    expect(p.warnings[0]).toMatch(/приблизительная/)
  })
})

describe('planMemory: ExLlamaV3', () => {
  const exl = (): LocalModel => ({ ...llama8b(), format: 'exl3', bpw: 4 })

  it('GPU-only: weights, KV and compute in VRAM; embeddings in RAM', () => {
    const p = planMemory(exl(), load(), rtx5060ti, 'exl3')
    expect(p.fit).toBe('full')
    expect(comp(p, 'kv').vramBytes).toBe(GiB)
    expect(comp(p, 'embd').ramBytes).toBeGreaterThan(0)
    expect(comp(p, 'attn').movable).toBe(false)
    expect(comp(p, 'kv').movable).toBe(false)
  })

  it('cache bits follow k/v types', () => {
    const p = planMemory(
      exl(),
      load({}, { kCacheType: { enabled: true, value: 'q8_0' }, vCacheType: { enabled: true, value: 'q4_0' } }),
      rtx5060ti,
      'exl3'
    )
    expect(comp(p, 'kv').vramBytes).toBe(Math.round(8192 * 32 * 8 * 128 * ((8.5 + 4.5) / 8)))
  })

  it('does not fit → none with an explanation', () => {
    const p = planMemory(exl(), load({}, { contextLength: 65536 }), gtx1660, 'exl3')
    expect(p.fit).toBe('none')
    expect(p.warnings.join(' ')).toMatch(/ExLlamaV3 не умеет выгружать/)
  })

  it('userSplit is not applicable: KV stays in VRAM with a warning', () => {
    const p = planMemory(exl(), load({ profile: 'userSplit' }), rtx5060ti, 'exl3')
    expect(p.resolved.kvCache).toBe('vram')
    expect(p.warnings.join(' ')).toMatch(/только в VRAM/)
  })
})

describe('estimateFitForFile', () => {
  it('with and without architecture', () => {
    const a = llama8b().arch!
    expect(estimateFitForFile(4.9 * GiB, a, rtx5060ti, 8192).fit).toBe('full')
    expect(estimateFitForFile(4.9 * GiB, undefined, rtx5060ti, 8192).fit).toBe('full')
    const p = estimateFitForFile(20 * GiB, undefined, rtx5060ti, 8192)
    expect(p.fit).toBe('partial')
    expect(p.note).toMatch(/RAM/)
    expect(estimateFitForFile(200 * GiB, undefined, rtx5060ti, 8192).fit).toBe('none')
    expect(estimateFitForFile(4.9 * GiB, a, noGpu, 8192).fit).toBe('ram')
    expect(estimateFitForFile(20 * GiB, undefined, rtx5060ti, 8192, { engine: 'exl3' }).fit).toBe('none')
  })
})
