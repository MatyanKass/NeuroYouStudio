import { createHash, randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { HfError } from '../../src/main/hf/client'
import { parseContentRange, transferFile, type TransferOptions, type TransferStatus } from '../../src/main/hf/transfer'
import { makeTempDir, startFileServer, startServer, type TestServer } from './helpers'

const data = randomBytes(3 * 1024 * 1024 + 12345)
const sha = createHash('sha256').update(data).digest('hex')

describe('transferFile', () => {
  let srv: TestServer
  let dir: string
  let target: string

  beforeAll(async () => {
    srv = await startFileServer({ 'a.bin': data })
  })
  afterAll(() => srv.close())
  beforeEach(async () => {
    dir = await makeTempDir()
    target = join(dir, 'sub', 'a.bin')
    srv.requests.length = 0
  })
  afterEach(() => rm(dir, { recursive: true, force: true }))

  const opts = (extra: Partial<TransferOptions> = {}): TransferOptions => ({
    signal: new AbortController().signal,
    retryBaseDelayMs: 5,
    stallTimeoutMs: 3000,
    ...extra
  })
  const spec = (mode: string, extra: { size?: number; sha256?: string } = {}) => ({
    url: `${srv.base}/${mode}/a.bin`,
    size: extra.size ?? data.length,
    sha256: 'sha256' in extra ? extra.sha256 : sha,
    target
  })
  const same = async (): Promise<boolean> => (await readFile(target)).equals(data)

  it('качает с нуля, SHA256 считается потоково', async () => {
    const statuses: TransferStatus['kind'][] = []
    const bytes: number[] = []
    const r = await transferFile(spec('file'), opts({ onStatus: (s) => statuses.push(s.kind), onBytes: (b) => bytes.push(b) }))
    expect(r).toEqual({ skipped: false, verified: true })
    expect(await same()).toBe(true)
    expect(statuses).not.toContain('verify')
    expect(bytes.at(-1)).toBe(data.length)
    expect(existsSync(`${target}.part`)).toBe(false)
    expect(srv.requests[0]?.headers.range).toBeUndefined()
  })

  it('докачивает .part через Range (206) и проверяет SHA256 отдельным проходом', async () => {
    await mkdir(dirname(target), { recursive: true })
    await writeFile(`${target}.part`, data.subarray(0, 1_000_000))
    const statuses: TransferStatus['kind'][] = []
    const r = await transferFile(spec('file'), opts({ onStatus: (s) => statuses.push(s.kind) }))
    expect(r.verified).toBe(true)
    expect(statuses).toContain('verify')
    expect(srv.requests.at(-1)?.headers.range).toBe('bytes=1000000-')
    expect(await same()).toBe(true)
  })

  it('сервер игнорирует Range (200) — качает заново, .part перезаписывается', async () => {
    await mkdir(dirname(target), { recursive: true })
    await writeFile(`${target}.part`, Buffer.alloc(500_000, 7))
    const statuses: TransferStatus['kind'][] = []
    const r = await transferFile(spec('norange'), opts({ onStatus: (s) => statuses.push(s.kind) }))
    expect(r.verified).toBe(true)
    expect(statuses).not.toContain('verify')
    expect(srv.requests[0]?.headers.range).toBe('bytes=500000-')
    expect(await same()).toBe(true)
  })

  it('пропускает уже скачанный файл', async () => {
    await transferFile(spec('file'), opts())
    srv.requests.length = 0
    expect(await transferFile(spec('file'), opts())).toEqual({ skipped: true, verified: false })
    expect(srv.requests).toHaveLength(0)
  })

  it('без sha256 — только проверка размера', async () => {
    const r = await transferFile(spec('file', { sha256: undefined }), opts())
    expect(r).toEqual({ skipped: false, verified: false })
    expect(await same()).toBe(true)
  })

  it('SHA256 не совпал: одна перекачка, затем ошибка и удаление .part', async () => {
    const err = await transferFile(spec('file', { sha256: 'f'.repeat(64) }), opts()).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(HfError)
    expect((err as HfError).code).toBe('integrity')
    expect((err as HfError).message).toMatch(/SHA256/)
    expect(srv.requests).toHaveLength(2)
    expect(existsSync(`${target}.part`)).toBe(false)
    expect(existsSync(target)).toBe(false)
  })

  it('размер на сервере не совпадает с ожидаемым → ошибка', async () => {
    const err = await transferFile(spec('file', { size: data.length - 5, sha256: undefined }), opts()).catch((e: unknown) => e)
    expect((err as HfError).code).toBe('integrity')
    expect((err as HfError).message).toMatch(/не совпадает/)
  })

  it('обрыв соединения → повтор с Range, файл целый', async () => {
    const statuses: TransferStatus[] = []
    const r = await transferFile(spec('drop'), opts({ onStatus: (s) => statuses.push(s) }))
    expect(r.verified).toBe(true)
    expect(await same()).toBe(true)
    expect(srv.requests.length).toBeGreaterThanOrEqual(2)
    expect(srv.requests[1]?.headers.range).toMatch(/^bytes=\d+-$/)
    expect(statuses.some((s) => s.kind === 'retry')).toBe(true)
    // докачка продолжила потоковый хэш — отдельной проверки не было
    expect(statuses.some((s) => s.kind === 'verify')).toBe(false)
  })

  it('зависшее соединение → таймаут и повтор', async () => {
    const r = await transferFile(spec('stall'), opts({ stallTimeoutMs: 300 }))
    expect(r.verified).toBe(true)
    expect(await same()).toBe(true)
    expect(srv.requests).toHaveLength(2)
  })

  it('503 → повтор', async () => {
    const r = await transferFile(spec('flaky'), opts())
    expect(r.verified).toBe(true)
    expect(srv.requests).toHaveLength(2)
  })

  it('404 не повторяется', async () => {
    const err = await transferFile(spec('notfound'), opts()).catch((e: unknown) => e)
    expect((err as HfError).code).toBe('notFound')
    expect(srv.requests).toHaveLength(1)
  })

  it('gated 401 → понятная ошибка', async () => {
    const err = await transferFile(spec('gated'), opts({ token: null })).catch((e: unknown) => e)
    expect((err as HfError).code).toBe('gated')
  })

  it('редирект на другой хост — без Authorization; на тот же — с ним', async () => {
    await transferFile(spec('redirect'), opts({ token: 'hf_secret' }))
    expect(srv.requests[0]?.headers.authorization).toBe('Bearer hf_secret')
    expect(srv.requests[1]?.host).toMatch(/^localhost:/)
    expect(srv.requests[1]?.headers.authorization).toBeUndefined()
    await rm(target)
    srv.requests.length = 0
    await transferFile(spec('relredirect'), opts({ token: 'hf_secret' }))
    expect(srv.requests.map((r) => r.headers.authorization)).toEqual(['Bearer hf_secret', 'Bearer hf_secret'])
  })

  it('прерывание оставляет .part, потом докачка', async () => {
    const ctl = new AbortController()
    const err = await transferFile(
      spec('slow'),
      opts({
        signal: ctl.signal,
        onBytes: (b) => {
          if (b > 0) ctl.abort('pause')
        }
      })
    ).catch((e: unknown) => e)
    expect(err).toBe('pause')
    const part = await stat(`${target}.part`)
    expect(part.size).toBeGreaterThan(0)
    expect(part.size).toBeLessThan(data.length)
    const r = await transferFile(spec('file'), opts())
    expect(r.verified).toBe(true)
    expect(srv.requests.at(-1)?.headers.range).toBe(`bytes=${part.size}-`)
    expect(await same()).toBe(true)
  })

  it('сдаётся после N попыток', async () => {
    const dead = await startServer(() => undefined)
    const url = `${dead.base}/file/a.bin`
    await dead.close()
    const retries: number[] = []
    const err = await transferFile(
      { url, size: 10, target },
      opts({ retryAttempts: 2, onStatus: (s) => s.kind === 'retry' && retries.push(s.attempt) })
    ).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(HfError)
    expect((err as HfError).code).toBe('network')
    expect(retries).toEqual([1, 2])
  })
})

it('parseContentRange', () => {
  expect(parseContentRange('bytes 10-19/100')).toEqual({ start: 10, end: 19, total: 100 })
  expect(parseContentRange('bytes 0-9/*')).toEqual({ start: 0, end: 9, total: undefined })
  expect(parseContentRange(null)).toBeNull()
})
