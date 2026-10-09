// Менеджер движков на поддельном сервере: ключ API, гонки загрузки/выгрузки, закрытие приложения.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { DEFAULT_LOAD_CONFIG } from '@shared/config'
import type { HardwareInfo, LocalModel } from '@shared/types'

const h = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require('node:fs') as typeof import('node:fs')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const osm = require('node:os') as typeof import('node:os')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const path = require('node:path') as typeof import('node:path')
  const dir = fs.mkdtempSync(path.join(osm.tmpdir(), 'nys-mgr-'))
  return {
    dir,
    server: path.join(dir, 'fake-server.cjs'),
    pids: path.join(dir, 'pids.txt'),
    inUse: null as ((id: string) => boolean) | null
  }
})

// Сервер: пишет свой pid, печатает ключ (как TabbyAPI), /health без ключа, остальное — только с ключом.
writeFileSync(
  h.server,
  `
const http = require('http')
const fs = require('fs')
const [port, key, pids] = [Number(process.argv[2]), process.argv[3], process.argv[4]]
fs.appendFileSync(pids, process.pid + '\\n')
const started = Date.now()
console.log('Your API key is: ' + key)
http.createServer((req, res) => {
  if (req.url === '/health') {
    const ok = Date.now() - started > 300
    res.writeHead(ok ? 200 : 503); res.end()
    return
  }
  if (req.headers.authorization !== 'Bearer ' + key) { res.writeHead(401); res.end(); return }
  res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"ok":true}')
}).listen(port, '127.0.0.1', () => console.log('listening on http://127.0.0.1:' + port))
setInterval(() => {}, 1000)
`
)

vi.mock('../../src/main/ipc', () => ({ emit: () => undefined, handle: () => undefined }))
vi.mock('../../src/main/paths', () => ({ logsDir: () => h.dir, tmpDownloadsDir: () => h.dir }))
vi.mock('../../src/main/settings', () => ({
  getSettings: () => ({ guardrails: 'off', defaultEngineGguf: 'llamacpp', selectedRuntimes: {} })
}))
vi.mock('../../src/main/hardware', () => ({
  getHardwareInfo: async (): Promise<HardwareInfo> => ({
    gpus: [{ index: 0, name: 'RTX 5060 Ti', vramTotalMiB: 16311, vramFreeMiB: 15000, driverVersion: '581.57', computeCap: '12.0' }],
    ramTotalMiB: 32768,
    ramFreeMiB: 20000,
    cpuName: 'CPU',
    cpuCores: 6,
    cpuThreads: 12,
    avx2: true,
    avx512: false
  }),
  shutdownHardware: () => undefined
}))
const model: LocalModel = {
  id: 'm',
  format: 'gguf',
  path: 'C:\\models\\m.gguf',
  files: [],
  sizeBytes: 639446688,
  publisher: 'Qwen',
  repo: 'r',
  name: 'm',
  quant: 'Q8_0',
  paramsLabel: '0.6B',
  isMoe: false,
  vision: false,
  isEmbedding: false
}
vi.mock('../../src/main/models/registry', () => ({ getModel: (id: string) => (id === 'm' ? model : undefined) }))
vi.mock('../../src/main/runtimes/manager', () => ({
  registerRuntimesIpc: () => undefined,
  resolveRuntime: async () => ({
    id: 'rt',
    engine: 'llamacpp',
    dir: h.dir,
    serverExe: process.execPath,
    entry: { id: 'rt', engine: 'llamacpp', backend: 'cuda', files: [], serverExe: 'x' }
  }),
  runtimeStore: () => ({ catalog: [] }),
  setRuntimeInUseCheck: (fn: (id: string) => boolean) => (h.inUse = fn),
  shutdownRuntimes: async () => undefined
}))
vi.mock('../../src/main/engines/adapters', async () => {
  const real = await vi.importActual<typeof import('../../src/main/engines/adapters')>('../../src/main/engines/adapters')
  const { createLogParser } = await import('../../src/main/engines/log-parser')
  const fake = {
    ...real.llamacppAdapter,
    buildLaunch: (i: { port: number; apiKey?: string }) => {
      const args = [h.server, String(i.port), i.apiKey ?? '', h.pids]
      return {
        exe: process.execPath,
        args,
        displayArgs: args.map((a) => (a === i.apiKey ? '***' : a)),
        env: process.env,
        cwd: h.dir,
        secrets: i.apiKey ? [i.apiKey] : []
      }
    },
    createLogParser
  }
  return { ...real, getAdapter: () => fake }
})

const mgr = await import('../../src/main/engines/manager')
mgr.registerEngineIpc()

const load = { ...DEFAULT_LOAD_CONFIG, contextLength: 1024 }

function alivePids(): number[] {
  if (!existsSync(h.pids)) return []
  return readFileSync(h.pids, 'utf8')
    .split(/\s+/)
    .filter(Boolean)
    .map(Number)
    .filter((pid) => {
      try {
        process.kill(pid, 0)
        return true
      } catch {
        return false
      }
    })
}

afterAll(async () => {
  await mgr.shutdownEngines()
  for (const pid of alivePids()) process.kill(pid)
})

describe('менеджер движков', () => {
  it('ключ API: без него 401, /health открыт, ключ не попадает в журнал и аргументы', async () => {
    const st = await mgr.loadModel('m', load)
    expect(st.state).toBe('ready')
    const eng = mgr.activeEngine()!
    expect(eng.apiKey).toMatch(/^[\w-]{32}$/)
    expect((await fetch(`${eng.baseUrl}/v1/models`)).status).toBe(401)
    expect((await fetch(`${eng.baseUrl}/health`)).status).toBe(200)
    const ok = await fetch(`${eng.baseUrl}/v1/models`, { headers: { Authorization: `Bearer ${eng.apiKey}` } })
    expect(ok.status).toBe(200)
    expect(mgr.engineLogs().join('\n')).toContain('Your API key is: ***')
    expect(mgr.engineLogs().join('\n')).not.toContain(eng.apiKey!)
    expect(st.plan?.args.join(' ')).not.toContain(eng.apiKey!)
    const logFile = readFileSync(join(h.dir, `engine-${new Date().toISOString().slice(0, 10)}.log`), 'utf8')
    expect(logFile).not.toContain(eng.apiKey!)
    expect(h.inUse?.('rt')).toBe(true)
  }, 30_000)

  it('ключ новый на каждый запуск', async () => {
    const first = mgr.activeEngine()!.apiKey
    await mgr.loadModel('m', load)
    expect(mgr.activeEngine()!.apiKey).not.toBe(first)
    expect(alivePids()).toHaveLength(1)
  }, 30_000)

  it('три загрузки подряд: готова последняя, процессы не живут одновременно', async () => {
    await mgr.unloadModel()
    const first = mgr.loadModel('m', load)
    // Первая успевает запустить процесс, потом две новые загрузки одна за другой.
    await new Promise((r) => setTimeout(r, 150))
    let maxAlive = 0
    const timer = setInterval(() => (maxAlive = Math.max(maxAlive, alivePids().length)), 10)
    const results = await Promise.allSettled([first, mgr.loadModel('m', load), mgr.loadModel('m', load)])
    clearInterval(timer)
    expect(results.map((r) => r.status)).toEqual(['rejected', 'rejected', 'fulfilled'])
    expect(mgr.engineStatus().state).toBe('ready')
    expect(alivePids()).toHaveLength(1)
    expect(maxAlive).toBe(1)
  }, 30_000)

  it('двойная выгрузка: обе дожидаются остановки процесса', async () => {
    const [a, b] = await Promise.all([mgr.unloadModel(), mgr.unloadModel()])
    expect(a.state).toBe('idle')
    expect(b.state).toBe('idle')
    expect(alivePids()).toHaveLength(0)
    expect(mgr.activeEngine()).toBeNull()
  }, 30_000)

  it('выгрузка во время загрузки отменяет её и не оставляет процессов', async () => {
    const p = mgr.loadModel('m', load)
    await new Promise((r) => setTimeout(r, 150))
    const st = await mgr.unloadModel()
    expect(st.state).toBe('idle')
    await expect(p).rejects.toMatchObject({ code: 'aborted' })
    expect(alivePids()).toHaveLength(0)
    expect(h.inUse?.('rt')).toBe(false)
  }, 30_000)

  it('закрытие приложения во время загрузки: процесс не запускается и не остаётся', async () => {
    const p = mgr.loadModel('m', load)
    await mgr.shutdownEngines()
    // Сразу после shutdownEngines: приложение вызывает app.quit(), ждать больше нельзя.
    expect(alivePids()).toHaveLength(0)
    await expect(p).rejects.toMatchObject({ code: 'aborted' })
    await expect(mgr.loadModel('m', load)).rejects.toMatchObject({ code: 'aborted' })
  }, 30_000)
})
