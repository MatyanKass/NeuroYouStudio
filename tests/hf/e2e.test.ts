// Живая проверка против huggingface.co. Запуск: NYS_HF_E2E=1 npx vitest run tests/hf/e2e.test.ts
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { HfClient } from '../../src/main/hf/client'
import { fetchModelDetails } from '../../src/main/hf/details'
import { DownloadManager, planDownload } from '../../src/main/hf/downloader'
import { makeTempDir, waitFor } from './helpers'

const REPO = 'CompendiumLabs/bge-small-en-v1.5-gguf'

async function sha256(path: string): Promise<string> {
  const h = createHash('sha256')
  for await (const c of createReadStream(path)) h.update(c as Buffer)
  return h.digest('hex')
}

describe.skipIf(!process.env.NYS_HF_E2E)('HuggingFace (живая сеть)', () => {
  let dir: string
  const client = new HfClient()

  beforeAll(async () => {
    dir = await makeTempDir()
  })
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('поиск GGUF и EXL3', async () => {
    const g = await client.search({ query: 'bge-small', format: 'gguf', sort: 'downloads', limit: 5 })
    expect(g.length).toBeGreaterThan(0)
    const e = await client.search({ query: '', format: 'exl3', sort: 'downloads', limit: 20 })
    expect(e.length).toBeGreaterThan(0)
    expect(e.every((m) => m.tags.includes('exl3'))).toBe(true)
  })

  it('детали EXL3 по веткам (turboderp)', async () => {
    const d = await fetchModelDetails({ client, modelsDir: dir }, 'turboderp/Qwen3.5-9B-exl3', 'exl3')
    expect(d.options.length).toBeGreaterThan(3)
    expect(d.options.every((o) => o.revision === o.key && o.sizeBytes > 1e9)).toBe(true)
  }, 60_000)

  it('реальная загрузка: пауза, продолжение, SHA256', async () => {
    const models = join(dir, 'models')
    const d = await fetchModelDetails({ client, modelsDir: models }, REPO, 'gguf')
    const opt = d.options.find((o) => o.quant === 'Q8_0')
    expect(opt).toBeDefined()
    if (!opt) return
    expect(opt.sizeBytes).toBeLessThan(100 * 1024 * 1024)
    const sha = opt.files[0]?.sha256
    expect(sha).toMatch(/^[0-9a-f]{64}$/)

    const m = new DownloadManager({ stateFile: join(dir, 'downloads.json'), emitIntervalMs: 100 })
    await m.init()
    const { id } = m.start(planDownload(models, d.id, 'gguf', opt))
    await waitFor(() => (m.get(id)?.receivedBytes ?? 0) > 2 * 1024 * 1024, 60_000, 'начало загрузки')
    await m.pause(id)
    expect(m.get(id)?.state).toBe('paused')
    await m.resume(id)
    const phases = new Set<string>()
    await waitFor(
      () => {
        const it = m.get(id)
        if (it) phases.add(it.phase.replace(/\d+%/, ''))
        return it?.state === 'done' || it?.state === 'error'
      },
      120_000,
      'конец загрузки'
    )
    expect(m.get(id)?.error).toBeUndefined()
    expect(m.get(id)?.state).toBe('done')
    const target = join(models, 'CompendiumLabs', 'bge-small-en-v1.5-gguf', 'bge-small-en-v1.5-q8_0.gguf')
    expect((await stat(target)).size).toBe(opt.sizeBytes)
    expect(await sha256(target)).toBe(sha)
    expect([...phases].some((p) => p.startsWith('Проверка'))).toBe(true)
    await m.shutdown()

    const again = await fetchModelDetails({ client, modelsDir: models }, REPO, 'gguf')
    expect(again.options.find((o) => o.quant === 'Q8_0')?.downloaded).toBe(true)
  }, 180_000)
})
