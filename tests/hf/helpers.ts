// Локальные HTTP-серверы для тестов загрузчика и клиента HF.
import { createServer, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export interface RecordedRequest {
  method: string
  url: string
  host: string
  headers: IncomingHttpHeaders
}

export interface TestServer {
  base: string
  /** Тот же сервер под другим именем хоста (для проверки редиректа на «чужой» хост). */
  altBase: string
  requests: RecordedRequest[]
  close(): Promise<void>
}

type Handler = (req: IncomingMessage, res: ServerResponse, srv: TestServer) => void

export async function startServer(handler: Handler): Promise<TestServer> {
  const requests: RecordedRequest[] = []
  const server = createServer()
  const srv: TestServer = {
    base: '',
    altBase: '',
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      })
  }
  server.on('request', (req, res) => {
    requests.push({ method: req.method ?? 'GET', url: req.url ?? '/', host: req.headers.host ?? '', headers: req.headers })
    handler(req, res, srv)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  srv.base = `http://127.0.0.1:${port}`
  srv.altBase = `http://localhost:${port}`
  return srv
}

interface SendOpts {
  range: boolean
  /** Отдать столько байт и оборвать соединение. */
  dropAfter?: number
  /** Отдать столько байт и замолчать. */
  stallAfter?: number
  slow?: { chunk: number; delayMs: number }
}

function sendFile(req: IncomingMessage, res: ServerResponse, data: Buffer, o: SendOpts): void {
  let start = 0
  let end = data.length - 1
  let status = 200
  const m = o.range ? /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? '') : null
  if (m) {
    start = Number(m[1])
    if (m[2]) end = Number(m[2])
    if (start >= data.length) {
      res.writeHead(416, { 'Content-Range': `bytes */${data.length}` })
      res.end()
      return
    }
    status = 206
  }
  const headers: Record<string, string> = {
    'Content-Length': String(end - start + 1),
    'Accept-Ranges': 'bytes',
    'Content-Type': 'application/octet-stream'
  }
  if (status === 206) headers['Content-Range'] = `bytes ${start}-${end}/${data.length}`
  res.writeHead(status, headers)
  const body = data.subarray(start, end + 1)
  if (o.dropAfter !== undefined) {
    res.write(body.subarray(0, o.dropAfter), () => setTimeout(() => res.socket?.destroy(), 30))
    return
  }
  if (o.stallAfter !== undefined) {
    res.write(body.subarray(0, o.stallAfter))
    return
  }
  if (o.slow) {
    const { chunk, delayMs } = o.slow
    let off = 0
    const step = (): void => {
      if (res.destroyed) return
      if (off >= body.length) {
        res.end()
        return
      }
      res.write(body.subarray(off, off + chunk))
      off += chunk
      setTimeout(step, delayMs)
    }
    step()
    return
  }
  res.end(body)
}

/**
 * Файловый сервер. Путь: /<режим>/.../<имя файла> (подходит и для /<режим>/<repo>/resolve/<rev>/<file>).
 * Режимы: file, norange, drop (1-й запрос обрывается), stall (1-й зависает), flaky (1-й — 503),
 * slow, redirect (на altBase), relredirect (относительный), notfound, gated.
 */
export async function startFileServer(
  files: Record<string, Buffer>,
  slow: { chunk: number; delayMs: number } = { chunk: 64 * 1024, delayMs: 15 }
): Promise<TestServer> {
  const hits = new Map<string, number>()
  return startServer((req, res, srv) => {
    const url = new URL(req.url ?? '/', 'http://x')
    const segs = url.pathname.split('/').filter(Boolean).map(decodeURIComponent)
    const mode = segs[0] ?? ''
    const name = segs[segs.length - 1] ?? ''
    const n = (hits.get(url.pathname) ?? 0) + 1
    hits.set(url.pathname, n)
    const data = files[name]
    if (mode === 'notfound' || !data) {
      res.writeHead(404, { 'X-Error-Code': 'EntryNotFound', 'X-Error-Message': 'Entry not found' })
      res.end()
      return
    }
    if (mode === 'gated') {
      res.writeHead(401, { 'X-Error-Code': 'GatedRepo' })
      res.end()
      return
    }
    if (mode === 'redirect') {
      res.writeHead(302, { Location: `${srv.altBase}/file/${encodeURIComponent(name)}` })
      res.end()
      return
    }
    if (mode === 'relredirect') {
      res.writeHead(302, { Location: `/file/${encodeURIComponent(name)}` })
      res.end()
      return
    }
    if (mode === 'flaky' && n === 1) {
      res.writeHead(503)
      res.end()
      return
    }
    const half = Math.floor(data.length / 2)
    sendFile(req, res, data, {
      range: mode !== 'norange',
      ...(mode === 'drop' && n === 1 ? { dropAfter: half } : {}),
      ...(mode === 'stall' && n === 1 ? { stallAfter: half } : {}),
      ...(mode === 'slow' ? { slow } : {})
    })
  })
}

/** Сервер, отдающий записанные ответы HF API по pathname. */
export async function startRouteServer(
  routes: Record<string, unknown>,
  hook?: (req: IncomingMessage, res: ServerResponse) => boolean
): Promise<TestServer> {
  return startServer((req, res) => {
    if (hook?.(req, res)) return
    const url = new URL(req.url ?? '/', 'http://x')
    const body = routes[url.pathname] ?? routes[decodeURIComponent(url.pathname)]
    if (body === undefined) {
      res.writeHead(404, { 'X-Error-Code': 'EntryNotFound' })
      res.end()
      return
    }
    if (typeof body === 'string') {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end(body)
    } else {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(body))
    }
  })
}

export async function loadFixture<T = Record<string, unknown>>(name: string): Promise<T> {
  return JSON.parse(await readFile(join(__dirname, 'fixtures', `${name}.json`), 'utf8')) as T
}

export const makeTempDir = (): Promise<string> => mkdtemp(join(tmpdir(), 'nys-hf-'))

export async function waitFor(cond: () => boolean, timeoutMs = 10_000, what = 'условие'): Promise<void> {
  const t0 = Date.now()
  while (!cond()) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`Не дождались: ${what}`)
    await new Promise((r) => setTimeout(r, 10))
  }
}
