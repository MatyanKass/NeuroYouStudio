import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  buildExl3Options,
  exl3QuantLabel,
  fileTarget,
  groupGgufOptions,
  modelDir,
  optionTargetPath,
  parseQuant,
  readmeExcerpt,
  sanitizeSegment,
  treeFiles,
  type Exl3Branch,
  type HfTreeEntry
} from '../../src/main/hf/options'
import { loadFixture } from './helpers'

type Routes = Record<string, unknown>

describe('parseQuant', () => {
  it.each([
    ['Qwen3.8-27B-UD-Q4_K_XL.gguf', 'UD-Q4_K_XL'],
    ['Qwen3.8-27B-Q4_0.gguf', 'Q4_0'],
    ['Qwen3.8-27B-UD-IQ2_XXS.gguf', 'UD-IQ2_XXS'],
    ['Qwen3-0.6B-Q8_0.gguf', 'Q8_0'],
    ['Qwen_Qwen3-4B-IQ4_XS.gguf', 'IQ4_XS'],
    ['Qwen3-4B.i1-Q4_K_M.gguf', 'Q4_K_M'],
    ['qwen2.5-0.5b-instruct-q4_k_m.gguf', 'Q4_K_M'],
    ['bge-small-en-v1.5-f16.gguf', 'F16'],
    ['Qwen3.8-27B-BF16-00001-of-00002.gguf', 'BF16'],
    ['gpt-oss-120b-MXFP4-00001-of-00003.gguf', 'MXFP4'],
    ['gpt-oss-20b-MXFP4_MOE.gguf', 'MXFP4_MOE'],
    ['Llama-3.2-1B-Instruct-Q4_0_4_4.gguf', 'Q4_0_4_4'],
    ['model-TQ1_0.gguf', 'TQ1_0'],
    ['phi-2.Q5_K_S.gguf', 'Q5_K_S'],
    ['mmproj-F16.gguf', 'F16'],
    ['imatrix_unsloth.gguf', ''],
    ['Qwen3-4B.gguf', '']
  ])('%s → %s', (name, quant) => {
    expect(parseQuant(name)).toBe(quant)
  })
})

describe('groupGgufOptions (unsloth/Qwen3.8-27B-GGUF)', async () => {
  const routes = await loadFixture<Routes>('gguf-unsloth-qwen3.8-27b')
  const tree = routes['/api/models/unsloth/Qwen3.8-27B-GGUF/tree/main'] as HfTreeEntry[]
  const files = treeFiles(tree)
  const { options, mmproj } = groupGgufOptions(files, 'main', 'abc123')

  it('берёт sha256 из lfs.oid и размеры LFS', () => {
    const q8 = files.find((f) => f.path === 'Qwen3.8-27B-Q8_0.gguf')
    expect(q8?.size).toBe(29047086048)
    expect(q8?.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(files.find((f) => f.path === 'README.md')?.sha256).toBeUndefined()
  })

  it('объединяет шарды из подпапки в один вариант', () => {
    const bf16 = options.find((o) => o.quant === 'BF16')
    expect(bf16).toBeDefined()
    expect(bf16?.key).toBe('BF16/Qwen3.8-27B-BF16-00001-of-00002.gguf')
    expect(bf16?.files.map((f) => f.path)).toEqual([
      'BF16/Qwen3.8-27B-BF16-00001-of-00002.gguf',
      'BF16/Qwen3.8-27B-BF16-00002-of-00002.gguf'
    ])
    expect(bf16?.sizeBytes).toBe(49986159616 + 4671576000)
    expect(bf16?.label).toBe('Qwen3.8-27B-BF16 (2 части)')
    expect(bf16?.commit).toBe('abc123')
  })

  it('отделяет mmproj и пропускает imatrix', () => {
    expect(mmproj.map((o) => o.key)).toEqual(['mmproj-F16.gguf', 'mmproj-BF16.gguf'])
    expect(mmproj.every((o) => o.isMmproj)).toBe(true)
    expect(mmproj.map((o) => o.quant)).toEqual(['F16', 'BF16'])
    expect(options.some((o) => /mmproj|imatrix/i.test(o.key))).toBe(false)
  })

  it('вариант на каждый квант, отсортировано по размеру', () => {
    // 24 одиночных кванта + MTP/… + BF16 (2 шарда)
    expect(options).toHaveLength(26)
    const sizes = options.map((o) => o.sizeBytes)
    expect([...sizes].sort((a, b) => a - b)).toEqual(sizes)
    expect(options[0]?.key).toBe('MTP/mtp-Qwen3.8-27B-Q4_0.gguf')
    expect(options.at(-1)?.quant).toBe('BF16')
    const xl = options.find((o) => o.key === 'Qwen3.8-27B-UD-Q4_K_XL.gguf')
    expect(xl?.quant).toBe('UD-Q4_K_XL')
    expect(xl?.label).toBe('Qwen3.8-27B-UD-Q4_K_XL')
    expect(xl?.revision).toBe('main')
    expect(options.every((o) => !o.isMmproj && !o.downloaded)).toBe(true)
  })
})

describe('groupGgufOptions: шарды без подпапки и неполные наборы', () => {
  it('группирует по префиксу и числу частей', () => {
    const { options } = groupGgufOptions([
      { path: 'm-Q4_K_M-00002-of-00003.gguf', size: 2 },
      { path: 'm-Q4_K_M-00001-of-00003.gguf', size: 1 },
      { path: 'm-Q4_K_M-00003-of-00003.gguf', size: 3 },
      { path: 'm-Q8_0.gguf', size: 100 },
      { path: 'Q6_K/m-00001-of-00002.gguf', size: 10 },
      { path: 'Q6_K/m-00002-of-00002.gguf', size: 10 },
      { path: 'README.md', size: 1 }
    ])
    expect(options.map((o) => [o.key, o.quant, o.files.length, o.sizeBytes])).toEqual([
      ['m-Q4_K_M-00001-of-00003.gguf', 'Q4_K_M', 3, 6],
      ['Q6_K/m-00001-of-00002.gguf', 'Q6_K', 2, 20],
      ['m-Q8_0.gguf', 'Q8_0', 1, 100]
    ])
    expect(options[0]?.label).toBe('m-Q4_K_M (3 части)')
  })
})

describe('EXL3', async () => {
  const turbo = await loadFixture<Routes>('exl3-turboderp-qwen3.5-9b')
  const refs = turbo['/api/models/turboderp/Qwen3.5-9B-exl3/refs'] as {
    branches: Array<{ name: string; targetCommit: string }>
  }
  const branches: Exl3Branch[] = refs.branches.map((b) => ({
    name: b.name,
    commit: b.targetCommit,
    files: treeFiles(turbo[`/api/models/turboderp/Qwen3.5-9B-exl3/tree/${b.name}`] as HfTreeEntry[])
  }))

  it('один вариант на ветку, main без весов пропускается', () => {
    const opts = buildExl3Options(branches, 'Qwen3.5-9B-exl3')
    expect(opts.map((o) => o.key)).toEqual(['2.00bpw', '2.50bpw', '3.00bpw', '3.50bpw', '4.00bpw', '5.00bpw', '6.00bpw'])
    const o4 = opts.find((o) => o.key === '4.00bpw')
    expect(o4?.revision).toBe('4.00bpw')
    expect(o4?.quant).toBe('4.00bpw')
    expect(o4?.commit).toBe(refs.branches.find((b) => b.name === '4.00bpw')?.targetCommit)
    expect(o4?.files.some((f) => f.path === '.gitattributes')).toBe(false)
    expect(o4?.files.find((f) => f.path === 'model.safetensors')?.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(o4?.sizeBytes).toBe(o4?.files.reduce((s, f) => s + f.size, 0))
  })

  it('main с весами EXL3 (ArtusDev) — метка из quantization_config', async () => {
    const artus = await loadFixture<Routes>('exl3-artusdev-electra-main')
    const repo = 'ArtusDev/L3.3-Electra-R1-70b_EXL3_2.5bpw_H8'
    const files = treeFiles(artus[`/api/models/${repo}/tree/main`] as HfTreeEntry[])
    const cfg = JSON.parse(artus[`/${repo}/resolve/main/config.json`] as string) as {
      quantization_config: { bits: number; head_bits: number }
    }
    const [opt] = buildExl3Options([{ name: 'main', files, quantConfig: cfg.quantization_config }], 'L3.3-Electra-R1-70b_EXL3_2.5bpw_H8')
    expect(opt?.key).toBe('main')
    expect(opt?.quant).toBe('2.5bpw_H8')
    expect(opt?.label).toBe('main (2.5bpw_H8)')
    expect(opt?.files.filter((f) => f.path.endsWith('.safetensors'))).toHaveLength(3)
  })

  it('exl3QuantLabel', () => {
    expect(exl3QuantLabel('6.0bpw_H6')).toBe('6.0bpw_H6')
    expect(exl3QuantLabel('main', { bits: 4, head_bits: 6 })).toBe('4.0bpw_H6')
    expect(exl3QuantLabel('main', undefined, 'Model-EXL3-3.5bpw-h8')).toBe('3.5bpw_H8')
    expect(exl3QuantLabel('main')).toBe('main')
  })

  it('ветка без safetensors не даёт варианта', () => {
    expect(buildExl3Options([{ name: 'x', files: [{ path: 'README.md', size: 1 }] }])).toEqual([])
  })
})

describe('пути', () => {
  const models = join('C:', 'models')
  it('GGUF: только имя файла в <author>/<repo>', () => {
    expect(fileTarget(models, 'unsloth/Qwen3.8-27B-GGUF', 'gguf', 'main', 'BF16/Qwen3.8-27B-BF16-00001-of-00002.gguf')).toBe(
      join(models, 'unsloth', 'Qwen3.8-27B-GGUF', 'Qwen3.8-27B-BF16-00001-of-00002.gguf')
    )
  })
  it('EXL3: <repo>__<ветка>, подпапки сохраняются, ветка очищается', () => {
    expect(fileTarget(models, 'a/B-exl3', 'exl3', 'feat/4.0bpw', 'sub/model.safetensors')).toBe(
      join(models, 'a', 'B-exl3__feat_4.0bpw', 'sub', 'model.safetensors')
    )
    expect(modelDir(models, 'a/B', 'exl3', '6.0bpw_H6')).toBe(join(models, 'a', 'B__6.0bpw_H6'))
    expect(
      optionTargetPath(models, 'a/B', 'exl3', {
        key: '4.0bpw',
        label: '',
        quant: '',
        revision: '4.0bpw',
        files: [],
        sizeBytes: 0,
        downloaded: false,
        isMmproj: false
      })
    ).toBe(join(models, 'a', 'B__4.0bpw'))
  })
  it('sanitizeSegment', () => {
    expect(sanitizeSegment('a:b*c?')).toBe('a_b_c_')
    expect(sanitizeSegment('..')).toBe('_')
    expect(sanitizeSegment('name. ')).toBe('name')
    expect(sanitizeSegment('CON')).toBe('_CON')
    expect(sanitizeSegment('4.0bpw/H6')).toBe('4.0bpw_H6')
  })
})

describe('readmeExcerpt', () => {
  it('убирает YAML front matter и обрезает', () => {
    const md = '---\nlicense: apache-2.0\ntags:\n- gguf\n---\n\n# Title\n\nText'
    expect(readmeExcerpt(md)).toBe('# Title\n\nText')
    const long = `---\na: 1\n---\n${'строка текста\n'.repeat(300)}`
    const ex = readmeExcerpt(long, 1500)
    expect(ex.length).toBeLessThanOrEqual(1501)
    expect(ex.endsWith('…')).toBe(true)
    expect(ex.startsWith('---')).toBe(false)
  })
  it('реальный README из фикстуры', async () => {
    const routes = await loadFixture<Routes>('gguf-unsloth-qwen3.8-27b')
    const ex = readmeExcerpt(routes['/unsloth/Qwen3.8-27B-GGUF/resolve/main/README.md'] as string)
    expect(ex.length).toBeGreaterThan(50)
    expect(ex.startsWith('---')).toBe(false)
  })
})
