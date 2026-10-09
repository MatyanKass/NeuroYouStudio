import { createHash, randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { DownloadItem } from '@shared/types'
import { DownloadManager, planDownload, type DownloadManagerOptions } from '../../src/main/hf/downloader'
import type { RichOption } from '../../src/main/hf/options'
import { makeTempDir, startFileServer, waitFor, type TestServer } from './helpers'

const model = randomBytes(2 * 1024 * 1024 + 777)
const proj = randomBytes(300 * 1024 + 5)
const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex')

function ggufOption(files: Array<{ path: string; data: Buffer }>, key = files[0]?.path ?? '', mm = false): RichOption {
  return {
    key,
    label: key,
    quant: mm ? 'F16' : 'Q4_K_M',
    revision: 'main',
    files: files.map((f) => ({ path: f.path, size: f.data.length, sha256: sha(f.data) })),
    sizeBytes: files.reduce((s, f) => s + f.data.length, 0),
    downloaded: false,
    isMmproj: mm
  }
}

describe('DownloadManager', () => {
  let srv: TestServer
  let dir: string
  let models: string
  let stateFile: string
  const managers: DownloadManager[] = []

  beforeAll(async () => {
    // медленный режим: 64 КБ каждые 15 мс ≈ 4 МБ/с
    srv = await startFileServer({ 'model-Q4_K_M.gguf': model, 'mmproj-F16.gguf': proj, 'model.safetensors': model, 'config.json': proj })
  })
  afterAll(() => srv.close())
  beforeEach(async () => {
    dir = await makeTempDir()
    models = join(dir, 'models')
    stateFile = join(dir, 'userData', 'downloads.json')
  })
  afterEach(async () => {
    for (const m of managers.splice(0)) await m.shutdown()
    await rm(dir, { recursive: true, force: true })
  })

  const make = (extra: Partial<DownloadManagerOptions> = {}): DownloadManager => {
    const m = new DownloadManager({
      stateFile,
      baseUrl: srv.base,
      emitIntervalMs: 50,
      transfer: { retryBaseDelayMs: 5, stallTimeoutMs: 3000 },
      diskFree: async () => null,
      ...extra
    })
    managers.push(m)
    return m
  }
  const item = (m: DownloadManager, id: string): DownloadItem => {
    const it = m.get(id)
    if (!it) throw new Error('нет загрузки')
    return it
  }

  it('скачивает вариант + mmproj в <models>/<author>/<repo>/, сохраняет состояние, зовёт onItemDone', async () => {
    const done: DownloadItem[] = []
    const updates: DownloadItem[][] = []
    const m = make({ onItemDone: (i) => void done.push(i), onUpdate: (u) => updates.push(u) })
    await m.init()
    const opt = ggufOption([{ path: 'Q4/model-Q4_K_M.gguf', data: model }])
    const mm = ggufOption([{ path: 'mmproj-F16.gguf', data: proj }], 'mmproj-F16.gguf', true)
    const plan = planDownload(models, 'file/Test-GGUF', 'gguf', opt, mm)
    expect(plan.title).toBe('Test-GGUF · Q4_K_M + mmproj')
    const started = m.start(plan)
    expect(['queued', 'downloading']).toContain(started.state)
    await waitFor(() => done.length === 1, 10_000, 'завершение')
    const fin = item(m, started.id)
    expect(fin).toMatchObject({ state: 'done', done: true, phase: 'Готово', totalBytes: model.length + proj.length })
    expect(fin.receivedBytes).toBe(fin.totalBytes)
    expect(fin.targetPath).toBe(join(models, 'file', 'Test-GGUF', 'model-Q4_K_M.gguf'))
    expect((await readFile(join(models, 'file', 'Test-GGUF', 'model-Q4_K_M.gguf'))).equals(model)).toBe(true)
    expect((await readFile(join(models, 'file', 'Test-GGUF', 'mmproj-F16.gguf'))).equals(proj)).toBe(true)
    // URL: /file/Test-GGUF/resolve/main/Q4/model-Q4_K_M.gguf
    expect(srv.requests.some((r) => r.url === '/file/Test-GGUF/resolve/main/Q4/model-Q4_K_M.gguf')).toBe(true)
    await m.persistNow()
    const saved = JSON.parse(await readFile(stateFile, 'utf8')) as { items: Array<{ id: string; state: string }> }
    expect(saved.items.find((i) => i.id === started.id)?.state).toBe('done')
    await waitFor(() => updates.some((u) => u.some((i) => i.state === 'done')), 2000, 'событие done')
  })

  it('пауза и продолжение (докачка .part)', async () => {
    const m = make()
    await m.init()
    const { id } = m.start(planDownload(models, 'slow/M', 'gguf', ggufOption([{ path: 'model-Q4_K_M.gguf', data: model }])))
    await waitFor(() => item(m, id).receivedBytes > 0, 10_000, 'прогресс')
    await m.pause(id)
    const paused = item(m, id)
    expect(paused.state).toBe('paused')
    expect(paused.speedBps).toBe(0)
    const part = join(models, 'slow', 'M', 'model-Q4_K_M.gguf.part')
    const partSize = (await stat(part)).size
    expect(partSize).toBeGreaterThan(0)
    expect(partSize).toBeLessThan(model.length)
    srv.requests.length = 0
    await m.resume(id)
    await waitFor(() => item(m, id).state === 'done', 15_000, 'готово после паузы')
    expect(srv.requests[0]?.headers.range).toBe(`bytes=${partSize}-`)
    expect((await readFile(join(models, 'slow', 'M', 'model-Q4_K_M.gguf'))).equals(model)).toBe(true)
  })

  it('скорость считается во время загрузки, события не чаще 4/с', async () => {
    const times: number[] = []
    const m = make({ emitIntervalMs: 250, speedSampleMs: 100, onUpdate: () => times.push(Date.now()) })
    await m.init()
    const { id } = m.start(planDownload(models, 'slow/S', 'gguf', ggufOption([{ path: 'model-Q4_K_M.gguf', data: model }])))
    let maxSpeed = 0
    await waitFor(
      () => {
        const it = item(m, id)
        maxSpeed = Math.max(maxSpeed, it.speedBps)
        return it.state === 'done'
      },
      15_000,
      'готово'
    )
    expect(maxSpeed).toBeGreaterThan(0)
    for (let i = 1; i < times.length; i++) expect((times[i] ?? 0) - (times[i - 1] ?? 0)).toBeGreaterThanOrEqual(240)
  })

  it('отмена удаляет .part и уже скачанные этой загрузкой файлы', async () => {
    const m = make()
    await m.init()
    const opt: RichOption = {
      ...ggufOption([{ path: 'config.json', data: proj }]),
      key: '4.0bpw',
      revision: '4.0bpw',
      files: [
        { path: 'config.json', size: proj.length },
        { path: 'sub/model.safetensors', size: model.length }
      ]
    }
    const plan = planDownload(models, 'slow/E-exl3', 'exl3', opt)
    const root = join(models, 'slow', 'E-exl3__4.0bpw')
    expect(plan.targetPath).toBe(root)
    expect(plan.files.map((f) => f.target)).toEqual([join(root, 'config.json'), join(root, 'sub', 'model.safetensors')])
    const { id } = m.start(plan)
    await waitFor(() => item(m, id).receivedBytes > proj.length, 10_000, 'второй файл')
    expect(existsSync(join(root, 'config.json'))).toBe(true)
    await m.cancel(id)
    expect(item(m, id).state).toBe('canceled')
    expect(existsSync(root)).toBe(false)
    expect(existsSync(join(models, 'slow'))).toBe(false)
  })

  it('отмена не трогает файлы, которые были на диске до загрузки', async () => {
    const m = make()
    await m.init()
    const mm = ggufOption([{ path: 'mmproj-F16.gguf', data: proj }], 'mmproj-F16.gguf', true)
    const first = m.start(planDownload(models, 'slow/P', 'gguf', mm))
    await waitFor(() => item(m, first.id).state === 'done', 10_000, 'mmproj')
    const second = m.start(
      planDownload(models, 'slow/P', 'gguf', ggufOption([{ path: 'model-Q4_K_M.gguf', data: model }]), mm)
    )
    await waitFor(() => item(m, second.id).receivedBytes > proj.length, 10_000, 'прогресс')
    await m.cancel(second.id)
    expect(existsSync(join(models, 'slow', 'P', 'mmproj-F16.gguf'))).toBe(true)
    expect(existsSync(join(models, 'slow', 'P', 'model-Q4_K_M.gguf.part'))).toBe(false)
  })

  it('после перезапуска незавершённые загрузки восстанавливаются на паузе', async () => {
    const m1 = make()
    await m1.init()
    const { id } = m1.start(planDownload(models, 'slow/R', 'gguf', ggufOption([{ path: 'model-Q4_K_M.gguf', data: model }])))
    await waitFor(() => item(m1, id).receivedBytes > 0, 10_000, 'прогресс')
    await m1.shutdown()
    const saved = JSON.parse(await readFile(stateFile, 'utf8')) as { items: Array<{ id: string; state: string }> }
    expect(saved.items[0]?.state).toBe('paused')

    const m2 = make()
    await m2.init()
    const restored = item(m2, id)
    expect(restored.state).toBe('paused')
    expect(restored.receivedBytes).toBeGreaterThan(0)
    await m2.resume(id)
    await waitFor(() => item(m2, id).state === 'done', 15_000, 'готово после перезапуска')
    expect((await readFile(join(models, 'slow', 'R', 'model-Q4_K_M.gguf'))).equals(model)).toBe(true)
  })

  it('мало места на диске → ошибка до начала загрузки', async () => {
    const m = make({ diskFree: async () => 1024 })
    await m.init()
    const { id } = m.start(planDownload(models, 'file/D', 'gguf', ggufOption([{ path: 'model-Q4_K_M.gguf', data: model }])))
    await waitFor(() => item(m, id).state === 'error', 5000, 'ошибка')
    expect(item(m, id).error).toMatch(/Недостаточно места на диске/)
    expect(srv.requests.some((r) => r.url.startsWith('/file/D/'))).toBe(false)
  })

  it('ошибка, повтор того же варианта не плодит дубликаты, clearFinished чистит', async () => {
    const m = make()
    await m.init()
    const plan = planDownload(models, 'notfound/X', 'gguf', ggufOption([{ path: 'model-Q4_K_M.gguf', data: model }]))
    const a = m.start(plan)
    await waitFor(() => item(m, a.id).state === 'error', 5000, 'ошибка')
    expect(item(m, a.id).error).toMatch(/Файл не найден/)
    const b = m.start(plan)
    expect(b.id).toBe(a.id)
    await waitFor(() => item(m, a.id).state === 'error', 5000, 'снова ошибка')
    expect(m.list()).toHaveLength(1)
    await m.clearFinished()
    expect(m.list()).toEqual([])
  })

  it('очередь: по одной загрузке за раз', async () => {
    const m = make()
    await m.init()
    const a = m.start(planDownload(models, 'slow/Q1', 'gguf', ggufOption([{ path: 'model-Q4_K_M.gguf', data: model }])))
    const b = m.start(planDownload(models, 'slow/Q2', 'gguf', ggufOption([{ path: 'model-Q4_K_M.gguf', data: model }])))
    expect(item(m, a.id).state).toBe('downloading')
    expect(item(m, b.id).state).toBe('queued')
    await m.pause(b.id)
    expect(item(m, b.id).state).toBe('paused')
    await waitFor(() => item(m, a.id).state === 'done', 15_000, 'первая')
    expect(item(m, b.id).state).toBe('paused')
    await m.cancel(b.id)
    expect(item(m, b.id).state).toBe('canceled')
  })
})
