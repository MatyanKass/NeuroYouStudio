import { mkdir, mkdtemp, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { deleteModelFiles, emptyModelCache, pickMmproj, scanModelsDir, type ModelCache } from '../../src/main/models/scan'
import { gemmaLike, mmprojLike, moeLike } from './fixtures'
import { writeExl3Folder } from './helpers/exl3-writer'

let root: string
const exists = (p: string): Promise<boolean> => stat(p).then(
  () => true,
  () => false
)

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'nys-models-'))
  const a = join(root, 'google', 'gemma-test-GGUF')
  await mkdir(a, { recursive: true })
  await writeFile(join(a, 'gemma-test-Q4_K_M.gguf'), gemmaLike().buf)
  await writeFile(join(a, 'gemma-test-Q8_0.gguf'), gemmaLike().buf)
  await writeFile(join(a, 'mmproj-F32.gguf'), mmprojLike())
  await writeFile(join(a, 'mmproj-F16.gguf'), mmprojLike())
  await writeFile(join(a, 'README.md'), '# test')

  const b = join(root, 'zai', 'moe-GGUF')
  await mkdir(b, { recursive: true })
  const split = moeLike(20)
  await writeFile(join(b, 'moe-Q4_K_M-00001-of-00002.gguf'), split.bufs[0]!)
  await writeFile(join(b, 'moe-Q4_K_M-00002-of-00002.gguf'), split.bufs[1]!)

  await writeExl3Folder(join(root, 'turboderp', 'Qwen3-30B-A3B-exl3__4.0bpw'))

  const c = join(root, 'junk', 'broken')
  await mkdir(c, { recursive: true })
  await writeFile(join(c, 'broken-Q4_0.gguf'), Buffer.from('GGUF garbage that is not really a gguf'))
  // лишняя глубина (> 4) не сканируется
  const deep = join(root, 'a', 'b', 'c', 'd', 'e')
  await mkdir(deep, { recursive: true })
  await writeFile(join(deep, 'deep-Q4_K_M.gguf'), gemmaLike().buf)
})

afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('scanModelsDir', () => {
  let cache: ModelCache = emptyModelCache()

  it('finds GGUF (incl. shards), EXL3 folders, attaches mmproj and reports errors', async () => {
    const r = await scanModelsDir(root, cache)
    cache = r.cache
    expect(r.cacheChanged).toBe(true)
    const ids = r.models.map((m) => m.id)
    expect(ids).toEqual([
      'google/gemma-test-GGUF/gemma-test-Q4_K_M.gguf',
      'google/gemma-test-GGUF/gemma-test-Q8_0.gguf',
      'junk/broken/broken-Q4_0.gguf',
      'turboderp/Qwen3-30B-A3B-exl3__4.0bpw',
      'zai/moe-GGUF/moe-Q4_K_M-00001-of-00002.gguf'
    ])

    const g = r.models[0]!
    expect(g.format).toBe('gguf')
    expect(g.publisher).toBe('google')
    expect(g.repo).toBe('gemma-test-GGUF')
    expect(g.name).toBe('gemma-test-Q4_K_M')
    expect(g.quant).toBe('Q4_K_M')
    expect(g.vision).toBe(true)
    expect(g.mmprojPath).toBe(join(root, 'google', 'gemma-test-GGUF', 'mmproj-F16.gguf'))
    expect(g.mmprojSizeBytes).toBe(mmprojLike().length)
    expect(g.arch?.nLayers).toBe(6)
    expect(g.tensors?.layers).toHaveLength(6)
    expect(g.chatTemplate).toBeTruthy()
    expect(g.error).toBeUndefined()

    const broken = r.models.find((m) => m.id.startsWith('junk/'))!
    expect(broken.error).toMatch(/Не удалось прочитать GGUF/)

    const moe = r.models.find((m) => m.repo === 'moe-GGUF')!
    expect(moe.files).toHaveLength(2)
    expect(moe.name).toBe('moe-Q4_K_M')
    expect(moe.isMoe).toBe(true)
    expect(moe.vision).toBe(false)
    expect(moe.sizeBytes).toBe(moeLike(20).bufs.reduce((s, b) => s + b.length, 0))

    const ex = r.models.find((m) => m.format === 'exl3')!
    expect(ex.repo).toBe('Qwen3-30B-A3B-exl3')
    expect(ex.publisher).toBe('turboderp')
    expect(ex.bpw).toBe(4)
    expect(ex.quant).toBe('4.0bpw')
    expect(ex.isMoe).toBe(true)
  })

  it('reuses the cache when nothing changed and reparses changed files', async () => {
    const r2 = await scanModelsDir(root, cache)
    expect(r2.cacheChanged).toBe(false)
    expect(r2.models.length).toBe(5)
    cache = r2.cache

    const p = join(root, 'google', 'gemma-test-GGUF', 'gemma-test-Q8_0.gguf')
    const t = new Date(Date.now() + 5000)
    await utimes(p, t, t)
    const r3 = await scanModelsDir(root, cache)
    expect(r3.cacheChanged).toBe(true)
    expect(r3.models.find((m) => m.path === p)?.arch?.nLayers).toBe(6)
  })

  it('skips downloads in progress (.part)', async () => {
    const d = join(root, 'zai', 'downloading')
    await mkdir(d, { recursive: true })
    await writeFile(join(d, 'big-Q4_K_M-00001-of-00002.gguf'), moeLike(20).bufs[0]!)
    await writeFile(join(d, 'big-Q4_K_M-00002-of-00002.gguf.part'), Buffer.alloc(10))
    const ex = join(root, 'turboderp', 'Other-exl3__3.0bpw')
    await writeExl3Folder(ex)
    await writeFile(join(ex, 'model-00003-of-00003.safetensors.part'), Buffer.alloc(10))
    const r = await scanModelsDir(root, cache)
    expect(r.models.find((x) => x.repo === 'downloading')).toBeUndefined()
    expect(r.models.find((x) => x.repo === 'Other-exl3')).toBeUndefined()
    await rm(d, { recursive: true, force: true })
    await rm(ex, { recursive: true, force: true })
  })

  it('reports missing shards', async () => {
    const d = join(root, 'zai', 'partial')
    await mkdir(d, { recursive: true })
    await writeFile(join(d, 'big-Q4_K_M-00001-of-00003.gguf'), moeLike(20).bufs[0]!)
    const r = await scanModelsDir(root, cache)
    const m = r.models.find((x) => x.repo === 'partial')!
    expect(m.error).toMatch(/Не хватает шардов: найдено 1 из 3/)
    await rm(d, { recursive: true, force: true })
  })
})

describe('pickMmproj', () => {
  it('prefers name match, then F16 → BF16 → others → F32', () => {
    expect(pickMmproj('/m/Qwen-Q4_K_M.gguf', ['/m/mmproj-F32.gguf', '/m/mmproj-BF16.gguf', '/m/mmproj-F16.gguf'])).toBe('/m/mmproj-F16.gguf')
    expect(pickMmproj('/m/x.gguf', ['/m/mmproj-F32.gguf', '/m/mmproj-BF16.gguf'])).toBe('/m/mmproj-BF16.gguf')
    expect(
      pickMmproj('/m/gemma-3-4b-it-Q4_K_M.gguf', ['/m/mmproj-qwen2.5-vl-7b-f16.gguf', '/m/mmproj-gemma-3-4b-it-f32.gguf'])
    ).toBe('/m/mmproj-gemma-3-4b-it-f32.gguf')
    expect(pickMmproj('/m/x.gguf', [])).toBeUndefined()
  })
})

describe('deleteModelFiles', () => {
  it('deletes all shards and the empty repo folder', async () => {
    const { models } = await scanModelsDir(root)
    const moe = models.find((m) => m.repo === 'moe-GGUF')!
    await deleteModelFiles(root, moe)
    expect(await exists(join(root, 'zai', 'moe-GGUF'))).toBe(false)
    expect(await exists(join(root, 'zai'))).toBe(false)
  })

  it('keeps the folder while other quants remain; drops mmproj with the last model', async () => {
    let { models } = await scanModelsDir(root)
    const dir = join(root, 'google', 'gemma-test-GGUF')
    await deleteModelFiles(root, models.find((m) => m.quant === 'Q8_0' && m.repo === 'gemma-test-GGUF')!)
    expect((await readdir(dir)).sort()).toEqual(['README.md', 'gemma-test-Q4_K_M.gguf', 'mmproj-F16.gguf', 'mmproj-F32.gguf'])
    ;({ models } = await scanModelsDir(root))
    await deleteModelFiles(root, models.find((m) => m.repo === 'gemma-test-GGUF')!)
    expect(await exists(dir)).toBe(false)
  })

  it('deletes an EXL3 folder and refuses paths outside the root', async () => {
    const { models } = await scanModelsDir(root)
    const ex = models.find((m) => m.format === 'exl3')!
    await deleteModelFiles(root, ex)
    expect(await exists(ex.path)).toBe(false)
    await expect(deleteModelFiles(root, { ...ex, path: join(root, '..', 'elsewhere') })).rejects.toThrow(/вне папки/)
  })
})
