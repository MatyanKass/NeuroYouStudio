// EngineProcess на поддельном сервере (node-скрипт): готовность по /health, журнал, ошибки, остановка.
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { llamaHealth } from '../../src/main/engines/adapters'
import { createLogParser } from '../../src/main/engines/log-parser'
import { EngineError, EngineProcess, exitCodeHint, freePort } from '../../src/main/engines/process'

const dir = mkdtempSync(join(os.tmpdir(), 'nys-proc-'))

// Сервер: 503 первые ~600 мс, потом 200. Пишет строки как llama-server.
const fakeServer = join(dir, 'fake-server.cjs')
writeFileSync(
  fakeServer,
  `
const http = require('http')
const port = Number(process.argv[2])
const mode = process.argv[3]
const started = Date.now()
console.log('0.00.100.000 I load_tensors:        CUDA0 model buffer size =   100.00 MiB')
console.error('0.00.100.001 I llama_kv_cache:      CUDA0 KV buffer size =    50.00 MiB')
if (mode === 'oom') {
  console.error('ggml_backend_cuda_buffer_type_alloc_buffer: allocating 9999.00 MiB on device 0: cudaMalloc failed: out of memory')
  console.error('llama_model_load: error loading model: failed')
  process.exit(1)
}
if (mode === 'silent-exit') process.exit(3)
if (mode === 'dll') process.exit(-1073741515)
if (process.argv[4]) console.log('Your API key is: ' + process.argv[4])
http.createServer((req, res) => {
  if (req.url === '/health') {
    const ok = Date.now() - started > 600
    res.writeHead(ok ? 200 : 503, { 'Content-Type': 'application/json' })
    res.end(ok ? '{"status":"ok"}' : '{"error":{"code":503,"message":"Loading model"}}')
    return
  }
  res.writeHead(404); res.end()
}).listen(port, '127.0.0.1', () => console.log('0.01.000.000 I srv  llama_server: listening on http://127.0.0.1:' + port))
setInterval(() => {}, 1000)
`
)

const procs: EngineProcess[] = []
afterAll(async () => {
  await Promise.all(procs.map((p) => p.stop()))
})

async function makeProc(
  mode: string,
  extra: Partial<ConstructorParameters<typeof EngineProcess>[0]> = {},
  secret?: string
): Promise<EngineProcess> {
  const port = await freePort()
  const args = [fakeServer, String(port), mode, ...(secret ? [secret] : [])]
  const p = new EngineProcess({
    spec: { exe: process.execPath, args, env: process.env, cwd: dir, secrets: secret ? [secret] : [] },
    port,
    parser: createLogParser(),
    healthcheck: llamaHealth,
    healthIntervalMs: 100,
    ...extra
  })
  procs.push(p)
  return p
}

describe('EngineProcess', () => {
  it('freePort даёт рабочий порт', async () => {
    const port = await freePort()
    expect(port).toBeGreaterThan(1024)
  })

  it('ждёт 200 от /health, собирает журнал и буферы, останавливается', async () => {
    const lines: string[] = []
    const logFile = join(dir, 'engine.log')
    const p = await makeProc('ok', { onLine: (l) => lines.push(l), logFile })
    p.start()
    await p.waitReady()
    expect(p.parser.actual.model).toEqual({ CUDA0: 100 })
    expect(p.parser.actual.kv).toEqual({ CUDA0: 50 })
    expect(p.lines.some((l) => l.includes('listening on'))).toBe(true)
    expect(lines.length).toBeGreaterThanOrEqual(3)
    await p.stop()
    expect(p.exited).toBe(true)
    expect(readFileSync(logFile, 'utf8')).toContain('KV buffer size')
  }, 20_000)

  it('ранний выход с OOM → EngineError с подсказкой', async () => {
    const p = await makeProc('oom')
    p.start()
    const err = await p.waitReady().then(
      () => null,
      (e: unknown) => e
    )
    expect(err).toBeInstanceOf(EngineError)
    expect((err as EngineError).code).toBe('oom')
    expect((err as Error).message).toMatch(/Не хватило видеопамяти/)
    expect((err as EngineError).details.join('\n')).toContain('cudaMalloc failed')
  }, 20_000)

  it('выход без понятной ошибки → код возврата в сообщении', async () => {
    const p = await makeProc('silent-exit')
    p.start()
    const err = (await p.waitReady().catch((e: unknown) => e)) as EngineError
    expect(err.code).toBe('other')
    expect(err.message).toMatch(/код 3/)
  }, 20_000)

  it('отмена ожидания', async () => {
    const p = await makeProc('ok')
    p.start()
    const ac = new AbortController()
    ac.abort()
    const err = (await p.waitReady(ac.signal).catch((e: unknown) => e)) as EngineError
    expect(err.code).toBe('aborted')
    await p.stop()
  }, 20_000)

  it('тайм-аут без активности', async () => {
    const p = await makeProc('ok', {
      healthcheck: async () => 'down',
      idleTimeoutMs: 300
    })
    p.start()
    const err = (await p.waitReady().catch((e: unknown) => e)) as EngineError
    expect(err.code).toBe('timeout')
    await p.stop()
  }, 20_000)
})

describe('EngineProcess: секреты', () => {
  it('ключ API не попадает ни в строки журнала, ни в файл', async () => {
    const lines: string[] = []
    const logFile = join(dir, 'secret.log')
    const p = await makeProc('ok', { onLine: (l) => lines.push(l), logFile }, 'S3CR3T-KEY')
    p.start()
    await p.waitReady()
    await p.stop()
    expect(lines).toContain('Your API key is: ***')
    expect(p.lines.join('\n')).not.toContain('S3CR3T-KEY')
    const file = readFileSync(logFile, 'utf8')
    expect(file).not.toContain('S3CR3T-KEY')
    expect(file).toContain('***')
  }, 20_000)
})

describe('EngineProcess: коды аварийного завершения Windows', () => {
  it('exitCodeHint: DLL не найдена и недопустимая инструкция', () => {
    expect(exitCodeHint(0xc0000135)).toMatch(/DLL/)
    expect(exitCodeHint(-1073741515)).toMatch(/DLL/)
    expect(exitCodeHint(0xc000001d)).toMatch(/AVX/)
    expect(exitCodeHint(1)).toBeNull()
    expect(exitCodeHint(null)).toBeNull()
  })

  it('процесс без DLL CUDA → понятная ошибка', async () => {
    const p = await makeProc('dll')
    p.start()
    const err = (await p.waitReady().catch((e: unknown) => e)) as EngineError
    expect(err.message).toMatch(/Не найдены библиотеки движка/)
  }, 20_000)
})
