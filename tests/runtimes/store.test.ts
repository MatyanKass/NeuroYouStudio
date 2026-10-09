// RuntimeStore на локальном HTTP-сервере: докачка, SHA256, распаковка с «сплющиванием», маркер, выбор сборки.
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, promises as fs, readFileSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import os from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { HardwareInfo, TaskProgress } from '@shared/types'
import type { RuntimeCatalogEntry } from '../../src/main/runtimes/catalog'
import { downloadFile } from '../../src/main/runtimes/download'
import { MARKER_FILE, RuntimeStore } from '../../src/main/runtimes/store'
import { makeZip } from './zip-helper'

const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex')

// Архив с одной папкой верхнего уровня (как у части сборок) и «cudart» без папки.
const mainZip = makeZip({
  'build/': '',
  'build/llama-server.exe': 'MZ fake server',
  'build/ggml.dll': 'dll',
  'build/sub/': '',
  'build/sub/a.txt': 'a'
})
const cudartZip = makeZip({ 'cudart64_12.dll': 'cudart', 'cublas64_12.dll': 'cublas' })
const big = Buffer.alloc(300_000, 7)

const rangeRequests: string[] = []
let server: Server
let base = ''

beforeAll(async () => {
  server = createServer((req, res) => {
    const files: Record<string, Buffer> = { '/main.zip': mainZip, '/cudart.zip': cudartZip, '/big.bin': big }
    const body = files[req.url ?? '']
    if (!body) {
      res.writeHead(404)
      res.end()
      return
    }
    const range = req.headers.range
    if (range) {
      rangeRequests.push(`${req.url} ${range}`)
      const start = Number(/bytes=(\d+)-/.exec(range)?.[1] ?? 0)
      if (start >= body.length) {
        res.writeHead(416)
        res.end()
        return
      }
      res.writeHead(206, {
        'Content-Length': body.length - start,
        'Content-Range': `bytes ${start}-${body.length - 1}/${body.length}`
      })
      res.end(body.subarray(start))
      return
    }
    res.writeHead(200, { 'Content-Length': body.length })
    res.end(body)
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const addr = server.address()
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
})

afterAll(() => {
  server.close()
})

const hwNvidia: HardwareInfo = {
  gpus: [{ index: 0, name: 'GTX 1660', vramTotalMiB: 6144, vramFreeMiB: 5000, driverVersion: '591.86', computeCap: '7.5' }],
  ramTotalMiB: 32000,
  ramFreeMiB: 16000,
  cpuName: 'Ryzen',
  cpuCores: 6,
  cpuThreads: 12,
  avx2: true,
  avx512: false,
  cudaVersion: '13.1'
}

function catalog(): RuntimeCatalogEntry[] {
  return [
    {
      id: 'test-cuda12',
      engine: 'llamacpp',
      version: 't',
      variant: 'CUDA 12',
      backend: 'cuda',
      title: 'Тест CUDA 12',
      description: '',
      files: [
        { name: 'main.zip', url: `${base}/main.zip`, sha256: sha(mainZip), size: mainZip.length },
        { name: 'cudart.zip', url: `${base}/cudart.zip`, sha256: sha(cudartZip), size: cudartZip.length }
      ],
      cuda: { version: '12.4', sass: ['86', '89'], ptx: [75, 80], minDriverSass: 527.41 },
      serverExe: 'llama-server.exe'
    },
    {
      id: 'test-cpu',
      engine: 'llamacpp',
      version: 't',
      variant: 'CPU',
      backend: 'cpu',
      title: 'Тест CPU',
      description: '',
      files: [{ name: 'main-cpu.zip', url: `${base}/main.zip`, sha256: sha(mainZip), size: mainZip.length }],
      serverExe: 'llama-server.exe'
    },
    {
      id: 'test-bad-sha',
      engine: 'ikllama',
      version: 't',
      variant: 'CPU',
      backend: 'cpu',
      title: 'Битая',
      description: '',
      files: [{ name: 'bad.zip', url: `${base}/main.zip`, sha256: '0'.repeat(64), size: mainZip.length }],
      serverExe: 'llama-server.exe'
    }
  ]
}

describe('downloadFile', () => {
  it('докачивает по Range и проверяет SHA256', async () => {
    const dir = mkdtempSync(join(os.tmpdir(), 'nys-dl-'))
    const dest = join(dir, 'big.bin')
    writeFileSync(`${dest}.part`, big.subarray(0, 100_000))
    const seen: number[] = []
    await downloadFile({ url: `${base}/big.bin`, dest, sha256: sha(big), size: big.length, onProgress: (r) => seen.push(r) })
    expect(readFileSync(dest).equals(big)).toBe(true)
    expect(existsSync(`${dest}.part`)).toBe(false)
    expect(rangeRequests).toContain('/big.bin bytes=100000-')
    expect(seen.at(-1)).toBe(big.length)
  })

  it('уже скачанный файл с верным хэшем не качается заново', async () => {
    const dir = mkdtempSync(join(os.tmpdir(), 'nys-dl-'))
    const dest = join(dir, 'big.bin')
    writeFileSync(dest, big)
    const before = rangeRequests.length
    await downloadFile({ url: `${base}/nope`, dest, sha256: sha(big), size: big.length })
    expect(rangeRequests.length).toBe(before)
  })

  it('неверный хэш → ошибка и удаление частичного файла', async () => {
    const dir = mkdtempSync(join(os.tmpdir(), 'nys-dl-'))
    const dest = join(dir, 'big.bin')
    await expect(
      downloadFile({ url: `${base}/big.bin`, dest, sha256: 'f'.repeat(64), size: big.length })
    ).rejects.toThrow(/Контрольная сумма/)
    expect(existsSync(`${dest}.part`)).toBe(false)
  })

  it('404 — без повторов', async () => {
    const dir = mkdtempSync(join(os.tmpdir(), 'nys-dl-'))
    await expect(downloadFile({ url: `${base}/missing`, dest: join(dir, 'x') })).rejects.toThrow(/404/)
  })
})

describe('RuntimeStore', () => {
  const root = mkdtempSync(join(os.tmpdir(), 'nys-rt-'))
  let store: RuntimeStore
  // Каталог ссылается на адрес тестового сервера — создаём после его запуска.
  beforeAll(() => {
    store = new RuntimeStore({
      runtimesDir: join(root, 'runtimes'),
      tmpDir: join(root, 'tmp'),
      catalog: catalog(),
      platform: 'win32'
    })
  })

  it('устанавливает: две части сливаются в одну папку, верхняя папка архива убирается', async () => {
    const progress: TaskProgress[] = []
    await store.install('test-cuda12', (p) => progress.push(p))
    const dir = store.dirOf('test-cuda12')
    expect(readFileSync(join(dir, 'llama-server.exe'), 'utf8')).toBe('MZ fake server')
    expect(existsSync(join(dir, 'cudart64_12.dll'))).toBe(true)
    expect(existsSync(join(dir, 'sub', 'a.txt'))).toBe(true)
    expect(existsSync(join(dir, 'build'))).toBe(false)
    const marker = JSON.parse(readFileSync(join(dir, MARKER_FILE), 'utf8')) as { id: string }
    expect(marker.id).toBe('test-cuda12')
    expect(progress.at(-1)).toMatchObject({ done: true, phase: 'Готово' })
    expect(progress.some((p) => p.phase === 'Распаковка')).toBe(true)
    // Архивы удалены после установки.
    expect(await fs.readdir(join(root, 'tmp'))).toEqual([])
  })

  it('list: установленные и рекомендованные', async () => {
    const list = await store.list(hwNvidia)
    const cuda = list.find((r) => r.id === 'test-cuda12')!
    expect(cuda.installed).toBe(true)
    expect(cuda.compatible).toBe(true)
    expect(cuda.recommended).toBe(true)
    expect(cuda.downloadBytes).toBe(mainZip.length + cudartZip.length)
    expect(cuda.description).toMatch(/JIT/)
    expect(list.find((r) => r.id === 'test-cpu')!.installed).toBe(false)
  })

  it('битая контрольная сумма → ошибка, сборка не установлена', async () => {
    await expect(store.install('test-bad-sha', () => undefined)).rejects.toThrow(/Контрольная сумма/)
    expect(await store.marker('test-bad-sha')).toBeNull()
  })

  it('resolve: выбранная → лучшая установленная → null', async () => {
    await store.install('test-cpu', () => undefined)
    expect((await store.resolve('llamacpp', hwNvidia))?.id).toBe('test-cuda12')
    expect((await store.resolve('llamacpp', hwNvidia, 'test-cpu'))?.id).toBe('test-cpu')
    expect((await store.resolve('llamacpp', hwNvidia, 'unknown'))?.id).toBe('test-cuda12')
    const r = await store.resolve('llamacpp', { ...hwNvidia, gpus: [] })
    expect(r?.id).toBe('test-cpu')
    expect(r?.serverExe).toBe(join(store.dirOf('test-cpu'), 'llama-server.exe'))
    expect(await store.resolve('ikllama', hwNvidia)).toBeNull()
  })

  it('remove', async () => {
    await store.remove('test-cpu')
    expect(await store.marker('test-cpu')).toBeNull()
    expect(existsSync(store.dirOf('test-cpu'))).toBe(false)
  })

  it('pendingInstalls: идущая установка видна до завершения', async () => {
    const p = store.install('test-cpu', () => undefined)
    expect(store.pendingInstalls()).toHaveLength(1)
    await p
    expect(store.pendingInstalls()).toHaveLength(0)
    await store.remove('test-cpu')
  })

  it('некорректный id отклоняется', () => {
    expect(() => store.dirOf('../evil')).toThrow()
  })
})
