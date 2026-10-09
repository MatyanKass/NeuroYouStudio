import { describe, expect, it } from 'vitest'
import { DEFAULT_LOAD_CONFIG, DEFAULT_MEMORY_LAYOUT, deepMerge, type LoadConfig, type MemoryLayout } from '@shared/config'
import type { LocalModel } from '@shared/types'
import {
  buildLlamaServerArgs,
  kvTypeFor,
  layerRangeRegex,
  OT_ATTN,
  otFfn,
  splitArgs,
  type LlamaArgsInput
} from '../../src/main/engines/llamacpp-args'

const model: LocalModel = {
  id: 'Qwen/Qwen3-0.6B-GGUF/Qwen3-0.6B-Q8_0.gguf',
  format: 'gguf',
  path: 'C:\\models\\Qwen3-0.6B-Q8_0.gguf',
  files: ['C:\\models\\Qwen3-0.6B-Q8_0.gguf'],
  sizeBytes: 639446688,
  publisher: 'Qwen',
  repo: 'Qwen3-0.6B-GGUF',
  name: 'Qwen3-0.6B',
  quant: 'Q8_0',
  paramsLabel: '0.6B',
  arch: {
    arch: 'qwen3',
    nLayers: 28,
    nEmbd: 1024,
    nHead: 16,
    nHeadKv: 8,
    headDimK: 128,
    headDimV: 128,
    contextLengthMax: 40960,
    nExperts: 0,
    nExpertsUsed: 0,
    slidingWindow: 0,
    swaLayers: 0,
    mlaKvDim: 0,
    recurrentLayers: 0,
    vocabSize: 151936
  },
  isMoe: false,
  vision: false,
  isEmbedding: false
}

function input(
  flavor: 'mainline' | 'ik',
  load: Partial<LoadConfig> = {},
  layout: Partial<MemoryLayout> = {},
  extra: Partial<LlamaArgsInput> = {}
): LlamaArgsInput {
  return {
    flavor,
    model,
    load: deepMerge(DEFAULT_LOAD_CONFIG, load),
    layout: { ...DEFAULT_MEMORY_LAYOUT, ...layout },
    nLayers: 28,
    port: 8080,
    threadsDefault: 6,
    gpuDevice: 'CUDA0',
    ...extra
  }
}

/** Значения после флага (для повторяющихся флагов — все). */
function values(args: string[], flag: string): string[] {
  const out: string[] = []
  args.forEach((a, i) => {
    if (a === flag && i + 1 < args.length) out.push(args[i + 1]!)
  })
  return out
}

describe('buildLlamaServerArgs: снимки', () => {
  it('mainline, настройки по умолчанию, всё на GPU', () => {
    expect(buildLlamaServerArgs(input('mainline'))).toEqual([
      '-m', 'C:\\models\\Qwen3-0.6B-Q8_0.gguf', '--host', '127.0.0.1', '--port', '8080',
      '-c', '8192', '--jinja', '--no-webui', '-np', '1',
      '-lv', '4', '--fit', 'off', '--kv-unified',
      '-t', '6', '-b', '2048', '-ub', '512',
      '-fa', 'on',
      '-ngl', '999'
    ])
  })

  it('ik, настройки по умолчанию, всё на GPU', () => {
    expect(buildLlamaServerArgs(input('ik'))).toEqual([
      '-m', 'C:\\models\\Qwen3-0.6B-Q8_0.gguf', '--host', '127.0.0.1', '--port', '8080',
      '-c', '8192', '--jinja', '--webui', 'none', '-np', '1',
      '-t', '6', '-b', '2048', '-ub', '512',
      '-fa', 'on',
      '-ngl', '999'
    ])
  })

  it('схема пользователя: KV в RAM + FA, все слои на GPU', () => {
    const args = buildLlamaServerArgs(input('mainline', { flashAttention: 'on' }, { kvCache: 'ram' }))
    expect(args.slice(-5)).toEqual(['-fa', 'on', '-ngl', '999', '-nkvo'])
  })

  it('mainline: полный набор опций', () => {
    const args = buildLlamaServerArgs(
      input(
        'mainline',
        {
          contextLength: 32768,
          cpuThreads: 8,
          evalBatchSize: 1024,
          physicalBatchSize: 256,
          maxParallel: 2,
          unifiedKvCache: false,
          ropeFrequencyBase: { enabled: true, value: 500000 },
          ropeFrequencyScale: { enabled: true, value: 0.5 },
          keepModelInMemory: true,
          tryMmap: false,
          seed: { enabled: true, value: 42 },
          flashAttention: 'auto',
          kCacheType: { enabled: true, value: 'q8_0' },
          vCacheType: { enabled: true, value: 'q6_0' },
          numExperts: 4,
          promptTemplate: { enabled: true, value: '{{ x }}' },
          speculative: { enabled: true, draftModelId: 'd', draftMax: 8, draftMin: 1, pMin: 0.6 },
          extraArgs: { enabled: true, value: '--cache-ram 0 --alias "my model"' }
        },
        { gpuLayers: 20, kvCache: 'ram', attention: 'ram', ffn: 'vram', output: 'ram', expertsCpuLayers: 5 },
        { draftModelPath: 'C:\\models\\draft.gguf', templateFile: 'C:\\tmp\\t.jinja' }
      )
    )
    expect(args).toEqual([
      '-m', 'C:\\models\\Qwen3-0.6B-Q8_0.gguf', '--host', '127.0.0.1', '--port', '8080',
      '-c', '32768', '--jinja', '--no-webui', '-np', '2',
      '-lv', '4', '--fit', 'off', '--no-kv-unified',
      '-t', '8', '-b', '1024', '-ub', '256',
      '--rope-freq-base', '500000', '--rope-freq-scale', '0.5',
      '--load-mode', 'mlock',
      '--seed', '42',
      '-fa', 'auto',
      '-ctk', 'q8_0', '-ctv', 'q8_0',
      '--override-kv', 'qwen3.expert_used_count=int:4',
      '--chat-template-file', 'C:\\tmp\\t.jinja',
      '-md', 'C:\\models\\draft.gguf', '-ngld', '999',
      '--spec-type', 'draft-simple', '--spec-draft-n-max', '8', '--spec-draft-n-min', '1', '--spec-draft-p-min', '0.6',
      '-ngl', '21', '-nkvo',
      '-ot', '^output\\.weight$=CPU',
      '-ot', '^token_embd\\.weight$=CPU',
      '-ot', '^blk\\.\\d+\\.(?:attn|ssm|time_mix)_(?!.*norm)=CPU',
      '--n-cpu-moe', '5',
      '--cache-ram', '0', '--alias', 'my model'
    ])
  })

  it('ik: полный набор опций', () => {
    const args = buildLlamaServerArgs(
      input(
        'ik',
        {
          keepModelInMemory: true,
          tryMmap: false,
          kCacheType: { enabled: true, value: 'q8_KV' },
          vCacheType: { enabled: true, value: 'q6_0' },
          speculative: { enabled: true, draftModelId: 'd', draftMax: 8, draftMin: 1, pMin: 0.6 }
        },
        { gpuLayers: 20, ffn: 'ram', expertsCpuLayers: -1 },
        { draftModelPath: 'C:\\models\\draft.gguf' }
      )
    )
    expect(args).toContain('--mlock')
    expect(args).toContain('--no-mmap')
    expect(args).not.toContain('--load-mode')
    expect(args).not.toContain('--fit')
    expect(args).not.toContain('-lv')
    expect(args).not.toContain('--kv-unified')
    expect(values(args, '-ctk')).toEqual(['q8_KV'])
    expect(values(args, '-ctv')).toEqual(['q6_0'])
    expect(values(args, '--spec-type')).toEqual(['draft:n_max=8,n_min=1,p_min=0.6'])
    expect(args).not.toContain('--spec-draft-n-max')
    // ik: -ngl считает блоки, голову на GPU переносим явно.
    expect(values(args, '-ngl')).toEqual(['20'])
    expect(values(args, '-ot')).toEqual([
      '^output\\.weight$=CUDA0',
      '^blk\\.\\d+\\.ffn_(up|down|gate|gate_up)\\.(weight|bias)$=CPU'
    ])
    expect(args).toContain('--cpu-moe')
  })
})

describe('buildLlamaServerArgs: раскладка памяти', () => {
  const ngl = (flavor: 'mainline' | 'ik', layout: Partial<MemoryLayout>): string[] =>
    values(buildLlamaServerArgs(input(flavor, {}, layout)), '-ngl')
  const ot = (flavor: 'mainline' | 'ik', layout: Partial<MemoryLayout>): string[] =>
    values(buildLlamaServerArgs(input(flavor, {}, layout)), '-ot')

  it('все слои: -1 и N >= nLayers дают 999', () => {
    expect(ngl('mainline', { gpuLayers: -1 })).toEqual(['999'])
    expect(ngl('mainline', { gpuLayers: 28 })).toEqual(['999'])
    expect(ngl('ik', { gpuLayers: 40 })).toEqual(['999'])
  })

  it('часть слоёв: mainline N+1 (с головой), ik N', () => {
    expect(ngl('mainline', { gpuLayers: 14 })).toEqual(['15'])
    expect(ot('mainline', { gpuLayers: 14 })).toEqual([])
    expect(ngl('ik', { gpuLayers: 14 })).toEqual(['14'])
    expect(ot('ik', { gpuLayers: 14 })).toEqual(['^output\\.weight$=CUDA0'])
  })

  it('голова в RAM', () => {
    expect(ngl('mainline', { gpuLayers: 14, output: 'ram' })).toEqual(['15'])
    expect(ot('mainline', { gpuLayers: 14, output: 'ram' })).toEqual(['^output\\.weight$=CPU', '^token_embd\\.weight$=CPU'])
    expect(ngl('ik', { gpuLayers: 14, output: 'ram' })).toEqual(['14'])
    expect(ot('ik', { gpuLayers: 14, output: 'ram' })).toEqual([])
    expect(ot('ik', { output: 'ram' })).toEqual(['^output\\.weight$=CPU', '^token_embd\\.weight$=CPU'])
  })

  it('ноль слоёв', () => {
    expect(ngl('mainline', { gpuLayers: 0, output: 'ram' })).toEqual(['0'])
    expect(ngl('mainline', { gpuLayers: 0 })).toEqual(['1'])
    expect(ngl('ik', { gpuLayers: 0 })).toEqual(['0'])
    expect(ot('ik', { gpuLayers: 0 })).toEqual([])
  })

  it('MTP/NextN-слои: -ngl для частичной выгрузки сдвигается на nextn', () => {
    const mtp = { ...model, arch: { ...model.arch!, nLayers: 46, nextnLayers: 1 } }
    const args = (flavor: 'mainline' | 'ik', layout: Partial<MemoryLayout>): string[] =>
      values(buildLlamaServerArgs({ ...input(flavor, {}, layout, { nLayers: 46 }), model: mtp }), '-ngl')
    expect(args('mainline', { gpuLayers: 20 })).toEqual(['22'])
    expect(args('ik', { gpuLayers: 20 })).toEqual(['21'])
    expect(args('mainline', { gpuLayers: 46 })).toEqual(['999'])
    expect(args('mainline', { gpuLayers: 0 })).toEqual(['1'])
    expect(args('ik', { gpuLayers: 0 })).toEqual(['0'])
  })

  it('CPU-сборка: -ngl 0 и никаких -ot/-nkvo', () => {
    const args = buildLlamaServerArgs(input('mainline', {}, { kvCache: 'ram', ffn: 'ram' }, { gpuDevice: undefined }))
    expect(values(args, '-ngl')).toEqual(['0'])
    expect(args).not.toContain('-ot')
    expect(args).not.toContain('-nkvo')
  })

  it('MoE: эксперты в RAM', () => {
    expect(buildLlamaServerArgs(input('mainline', {}, { expertsCpuLayers: 12 }))).toEqual(
      expect.arrayContaining(['--n-cpu-moe', '12'])
    )
    expect(buildLlamaServerArgs(input('ik', {}, { expertsCpuLayers: -1 }))).toContain('--cpu-moe')
  })

  it('ffnCpuLayers — диапазон первых N блоков; -1 или >= nLayers — все', () => {
    expect(ot('mainline', { ffnCpuLayers: 3 })).toEqual(['^blk\\.(?:0|1|2)\\.ffn_(up|down|gate|gate_up)\\.(weight|bias)$=CPU'])
    expect(ot('ik', { ffnCpuLayers: -1 })).toEqual(['^blk\\.\\d+\\.ffn_(up|down|gate|gate_up)\\.(weight|bias)$=CPU'])
    expect(ot('ik', { ffnCpuLayers: 28 })).toEqual(['^blk\\.\\d+\\.ffn_(up|down|gate|gate_up)\\.(weight|bias)$=CPU'])
    expect(ot('ik', { ffnCpuLayers: 0 })).toEqual([])
  })

  it('Vulkan: устройство Vulkan0 в -ot', () => {
    const args = buildLlamaServerArgs(input('ik', {}, { gpuLayers: 10 }, { gpuDevice: 'Vulkan0' }))
    expect(values(args, '-ot')).toEqual(['^output\\.weight$=Vulkan0'])
  })
})

describe('buildLlamaServerArgs: прочее', () => {
  it('mmproj: путь и --no-mmproj-offload при mmproj в RAM', () => {
    const vis = { ...model, vision: true, mmprojPath: 'C:\\models\\mmproj.gguf' }
    const a1 = buildLlamaServerArgs({ ...input('mainline'), model: vis })
    expect(values(a1, '--mmproj')).toEqual(['C:\\models\\mmproj.gguf'])
    expect(a1).not.toContain('--no-mmproj-offload')
    const a2 = buildLlamaServerArgs({ ...input('ik', {}, { mmproj: 'ram' }), model: vis })
    expect(a2).toContain('--no-mmproj-offload')
  })

  it('cpuThreads = 0 → потоки по умолчанию (физические ядра)', () => {
    expect(values(buildLlamaServerArgs(input('mainline', { cpuThreads: 0 }, {}, { threadsDefault: 12 })), '-t')).toEqual(['12'])
  })

  it('mmap без mlock: в mainline ничего, без mmap — --load-mode none', () => {
    expect(buildLlamaServerArgs(input('mainline'))).not.toContain('--load-mode')
    expect(values(buildLlamaServerArgs(input('mainline', { tryMmap: false })), '--load-mode')).toEqual(['none'])
    expect(values(buildLlamaServerArgs(input('mainline', { keepModelInMemory: true })), '--load-mode')).toEqual(['mmap+mlock'])
  })

  it('speculative без пути к черновику не добавляет флагов', () => {
    const args = buildLlamaServerArgs(input('mainline', { speculative: { ...DEFAULT_LOAD_CONFIG.speculative, enabled: true } }))
    expect(args).not.toContain('-md')
  })

  it('extraArgs идут последними', () => {
    const args = buildLlamaServerArgs(input('ik', { extraArgs: { enabled: true, value: '-ngl 5' } }))
    expect(args.slice(-2)).toEqual(['-ngl', '5'])
  })

  it('без -ot в шаблонах нет запятых (mainline делит значение -ot по запятым)', () => {
    const args = buildLlamaServerArgs(input('mainline', {}, { attention: 'ram', ffn: 'ram', output: 'ram' }))
    for (const r of values(args, '-ot')) expect(r).not.toContain(',')
  })
})

describe('шаблоны -ot совпадают с нужными тензорами', () => {
  const rx = (rule: string): RegExp => new RegExp(rule.slice(0, rule.lastIndexOf('=')))
  it('ffn не задевает экспертов MoE', () => {
    const r = rx(`${otFfn()}=CPU`)
    expect(r.test('blk.0.ffn_up.weight')).toBe(true)
    expect(r.test('blk.12.ffn_gate.weight')).toBe(true)
    expect(r.test('blk.3.ffn_down.weight')).toBe(true)
    expect(r.test('blk.3.ffn_up_exps.weight')).toBe(false)
    expect(r.test('blk.3.ffn_down_shexp.weight')).toBe(false)
    expect(r.test('blk.3.ffn_norm.weight')).toBe(false)
  })
  it('attention (и ssm_/time_mix_ гибридов) без норм', () => {
    const r = new RegExp(OT_ATTN)
    expect(r.test('blk.0.attn_q.weight')).toBe(true)
    expect(r.test('blk.0.attn_output.weight')).toBe(true)
    expect(r.test('blk.0.attn_kv_a_mqa.weight')).toBe(true)
    expect(r.test('blk.0.attn_norm.weight')).toBe(false)
    expect(r.test('blk.0.attn_q_norm.weight')).toBe(false)
    expect(r.test('blk.5.ssm_in.weight')).toBe(true)
    expect(r.test('blk.5.ssm_conv1d.weight')).toBe(true)
    expect(r.test('blk.5.ssm_out.weight')).toBe(true)
    expect(r.test('blk.5.ssm_norm.weight')).toBe(false)
    expect(r.test('blk.2.time_mix_key.weight')).toBe(true)
    expect(r.test('blk.2.ffn_up.weight')).toBe(false)
  })
  it('голова не путается с attn_output', () => {
    expect(/^output\.weight$/.test('blk.1.attn_output.weight')).toBe(false)
    expect(/^output\.weight$/.test('output.weight')).toBe(true)
  })
  it('диапазон слоёв', () => {
    const r = new RegExp(`^blk\\.${layerRangeRegex(12)}\\.`)
    expect(r.test('blk.11.ffn_up.weight')).toBe(true)
    expect(r.test('blk.12.ffn_up.weight')).toBe(false)
    expect(r.test('blk.1.ffn_up.weight')).toBe(true)
  })
})

describe('splitArgs', () => {
  it('кавычки и пробелы', () => {
    expect(splitArgs('  --a 1   --b "two words" --c \'x y\' ')).toEqual(['--a', '1', '--b', 'two words', '--c', 'x y'])
    expect(splitArgs('--json "{\\"k\\": 1}"')).toEqual(['--json', '{"k": 1}'])
    expect(splitArgs('--empty ""')).toEqual(['--empty', ''])
    expect(splitArgs('')).toEqual([])
    expect(splitArgs('C:\\path\\to')).toEqual(['C:\\path\\to'])
  })
})

describe('kvTypeFor', () => {
  it('ik-only типы в mainline заменяются на q8_0', () => {
    expect(kvTypeFor('mainline', 'q8_KV')).toBe('q8_0')
    expect(kvTypeFor('mainline', 'q6_0')).toBe('q8_0')
    expect(kvTypeFor('mainline', 'q4_0')).toBe('q4_0')
    expect(kvTypeFor('ik', 'q6_0')).toBe('q6_0')
  })
})
