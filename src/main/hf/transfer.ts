// Загрузка одного файла: докачка через Range, редиректы на CDN, проверка размера и SHA256, повторы.
import { createHash, type Hash } from 'node:crypto'
import { createReadStream, promises as fs } from 'node:fs'
import { dirname } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { HfError, USER_AGENT, describeFetchError, describeHttpError } from './client'
import { formatSize } from './fit'

export interface TransferSpec {
  url: string
  size: number
  sha256?: string
  target: string
}

export type TransferStatus =
  | { kind: 'download' }
  | { kind: 'verify'; done: number; total: number }
  | { kind: 'retry'; attempt: number; maxAttempts: number; delayMs: number; message: string }

export interface TransferOptions {
  signal: AbortSignal
  token?: string | null
  fetchImpl?: typeof fetch
  /** Нет данных дольше — соединение считается зависшим. */
  stallTimeoutMs?: number
  retryAttempts?: number
  retryBaseDelayMs?: number
  /** Байт файла на диске (с учётом докачки). */
  onBytes?: (bytes: number) => void
  onStatus?: (s: TransferStatus) => void
}

export interface TransferResult {
  /** Файл уже был на диске целиком — ничего не качали. */
  skipped: boolean
  /** Проверен ли SHA256. */
  verified: boolean
}

const FLUSH_BYTES = 4 * 1024 * 1024
/** Сбрасывать на диск и не реже — чтобы прогресс шёл и на медленном канале. */
const FLUSH_INTERVAL_MS = 250
const MAX_REDIRECTS = 10

export const partPath = (target: string): string => `${target}.part`

async function statSize(p: string): Promise<number | null> {
  try {
    const st = await fs.stat(p)
    return st.isFile() ? st.size : null
  } catch {
    return null
  }
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('Aborted', 'AbortError')
}

const FS_MESSAGES: Record<string, string> = {
  ENOSPC: 'Недостаточно места на диске.',
  EACCES: 'Нет доступа к папке моделей (права доступа).',
  EPERM: 'Нет доступа к файлу (он занят или защищён).',
  EBUSY: 'Файл занят другим процессом.',
  EROFS: 'Диск доступен только для чтения.',
  EMFILE: 'Слишком много открытых файлов.'
}

function isFsError(e: unknown): e is NodeJS.ErrnoException {
  return Boolean(e && typeof e === 'object' && 'syscall' in e && typeof (e as NodeJS.ErrnoException).code === 'string')
}

/** Ошибка → HfError с русским текстом. */
export function toHfError(e: unknown): HfError {
  if (e instanceof HfError) return e
  if (isFsError(e)) {
    const text = FS_MESSAGES[e.code ?? ''] ?? `Ошибка записи на диск (${e.code}).`
    return new HfError(text, 'disk', { cause: e })
  }
  return describeFetchError(e)
}

function isRetryable(e: unknown): boolean {
  if (e instanceof HfError) return e.retryable
  if (isFsError(e)) return false
  return true
}

/** Content-Range: bytes a-b/total. */
export function parseContentRange(v: string | null): { start: number; end: number; total?: number } | null {
  const m = /^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i.exec((v ?? '').trim())
  if (!m) return null
  return { start: Number(m[1]), end: Number(m[2]), total: m[3] === '*' ? undefined : Number(m[3]) }
}

/** GET с ручными редиректами: Authorization только на исходный origin. */
export async function openDownload(
  url: string,
  start: number,
  token: string | null | undefined,
  signal: AbortSignal,
  fetchImpl: typeof fetch = fetch
): Promise<Response> {
  let current = new URL(url)
  const origin = current.origin
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const headers: Record<string, string> = { 'User-Agent': USER_AGENT, 'Accept-Encoding': 'identity' }
    if (start > 0) headers.Range = `bytes=${start}-`
    if (token && current.origin === origin) headers.Authorization = `Bearer ${token}`
    const res = await fetchImpl(current, { headers, redirect: 'manual', signal })
    const loc = res.headers.get('location')
    if (res.status >= 300 && res.status < 400 && loc) {
      await res.body?.cancel().catch(() => undefined)
      current = new URL(loc, current)
      continue
    }
    return res
  }
  throw new HfError('Слишком много перенаправлений при загрузке файла.', 'http')
}

async function writeAll(fh: fs.FileHandle, data: Buffer): Promise<void> {
  let off = 0
  while (off < data.length) {
    const { bytesWritten } = await fh.write(data, off, data.length - off)
    off += bytesWritten
  }
}

/** SHA256 файла с прогрессом; прерывается сигналом. */
export async function hashFile(path: string, signal: AbortSignal, onProgress?: (done: number) => void): Promise<string> {
  const h = createHash('sha256')
  const stream = createReadStream(path, { highWaterMark: FLUSH_BYTES })
  let done = 0
  try {
    for await (const chunk of stream) {
      if (signal.aborted) throw abortReason(signal)
      h.update(chunk as Buffer)
      done += (chunk as Buffer).length
      onProgress?.(done)
    }
  } finally {
    stream.destroy()
  }
  return h.digest('hex')
}

export async function transferFile(spec: TransferSpec, opts: TransferOptions): Promise<TransferResult> {
  const { signal } = opts
  const fetchImpl = opts.fetchImpl ?? fetch
  const stallMs = opts.stallTimeoutMs ?? 60_000
  const maxAttempts = opts.retryAttempts ?? 5
  const baseDelay = opts.retryBaseDelayMs ?? 2_000
  const expectedSha = spec.sha256?.toLowerCase()
  const part = partPath(spec.target)

  if (signal.aborted) throw abortReason(signal)
  if ((await statSize(spec.target)) === spec.size) {
    opts.onBytes?.(spec.size)
    return { skipped: true, verified: false }
  }
  await fs.mkdir(dirname(spec.target), { recursive: true })
  if (spec.size === 0) {
    await fs.writeFile(spec.target, '')
    return { skipped: false, verified: false }
  }

  // Хэш считается потоково, пока байты на диске совпадают с захэшированными.
  let hash: Hash | null = null
  let hashed = 0
  let attempt = 0
  let bytesAtFailure = -1
  let checksumRestarted = false
  let rangeRestarted = false

  for (;;) {
    if (signal.aborted) throw abortReason(signal)
    let have = (await statSize(part)) ?? 0
    if (have > spec.size) {
      await fs.rm(part, { force: true })
      have = 0
    }
    if (expectedSha) {
      if (have === 0) {
        hash = createHash('sha256')
        hashed = 0
      } else if (!hash || hashed !== have) {
        hash = null
      }
    }
    opts.onBytes?.(have)

    if (have < spec.size) {
      opts.onStatus?.({ kind: 'download' })
      const attemptCtl = new AbortController()
      const attemptSignal = AbortSignal.any([signal, attemptCtl.signal])
      let stallTimer: NodeJS.Timeout | undefined
      const armStall = (): void => {
        clearTimeout(stallTimer)
        stallTimer = setTimeout(() => attemptCtl.abort(new Error('stall')), stallMs)
      }
      let fh: fs.FileHandle | null = null
      let pending: Promise<void> = Promise.resolve()
      let written = have
      try {
        armStall()
        const res = await openDownload(spec.url, have, opts.token, attemptSignal, fetchImpl)
        if (res.status === 416) {
          await res.body?.cancel().catch(() => undefined)
          await fs.rm(part, { force: true })
          if (rangeRestarted) throw new HfError('Сервер отклонил докачку файла.', 'http', { status: 416 })
          rangeRestarted = true
          continue
        }
        if (!res.ok) {
          await res.body?.cancel().catch(() => undefined)
          throw describeHttpError(res.status, res.headers, Boolean(opts.token))
        }
        let append = false
        if (res.status === 206 && have > 0) {
          const cr = parseContentRange(res.headers.get('content-range'))
          if (!cr || cr.start !== have) {
            await res.body?.cancel().catch(() => undefined)
            await fs.rm(part, { force: true })
            if (rangeRestarted) throw new HfError('Сервер вернул неверный диапазон данных.', 'http')
            rangeRestarted = true
            continue
          }
          if (cr.total !== undefined && cr.total !== spec.size) {
            await res.body?.cancel().catch(() => undefined)
            throw sizeChanged(cr.total, spec.size)
          }
          append = true
        } else {
          // 200 — сервер отдаёт файл целиком: начинаем заново.
          const len = Number(res.headers.get('content-length'))
          if (res.headers.has('content-length') && Number.isFinite(len) && len !== spec.size) {
            await res.body?.cancel().catch(() => undefined)
            throw sizeChanged(len, spec.size)
          }
          written = 0
          if (expectedSha) {
            hash = createHash('sha256')
            hashed = 0
          }
        }
        if (!res.body) throw new HfError('Пустой ответ сервера.', 'network')

        fh = await fs.open(part, append ? 'a' : 'w')
        const handle = fh
        let buf: Uint8Array[] = []
        let bufLen = 0
        const flush = (): Promise<void> => {
          if (!bufLen) return pending
          const data = Buffer.concat(buf, bufLen)
          buf = []
          bufLen = 0
          pending = pending.then(async () => {
            await writeAll(handle, data)
            if (hash) {
              hash.update(data)
              hashed += data.length
            }
            written += data.length
            opts.onBytes?.(written)
          })
          return pending
        }
        let received = written
        let lastFlush = Date.now()
        try {
          for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
            armStall()
            received += chunk.length
            if (received > spec.size) throw new HfError('Сервер прислал больше данных, чем ожидалось.', 'integrity')
            buf.push(chunk)
            bufLen += chunk.length
            if (bufLen >= FLUSH_BYTES || Date.now() - lastFlush >= FLUSH_INTERVAL_MS) {
              await pending
              lastFlush = Date.now()
              void flush().catch(() => undefined)
            }
          }
        } finally {
          // Всё, что успели получить, — на диск (меньше качать при докачке).
          await flush().catch(() => undefined)
        }
        await pending
        if (written < spec.size) throw new HfError('Соединение прервалось до конца файла.', 'network')
      } catch (e) {
        await pending.catch(() => undefined)
        if (signal.aborted) throw abortReason(signal)
        let err: unknown = e
        if (attemptCtl.signal.aborted) {
          err = new HfError(`Нет данных от сервера дольше ${Math.round(stallMs / 1000)} с.`, 'network', { cause: e })
        }
        if (err instanceof HfError && err.code === 'integrity') {
          await fs.rm(part, { force: true })
          throw err
        }
        if (!isRetryable(err)) throw toHfError(err)
        const now = (await statSize(part)) ?? 0
        if (now > bytesAtFailure) attempt = 0
        bytesAtFailure = now
        attempt++
        if (attempt > maxAttempts) throw toHfError(err)
        const retryAfter = err instanceof HfError ? (err.retryAfterMs ?? 0) : 0
        const delayMs = Math.max(baseDelay * 2 ** (attempt - 1), Math.min(retryAfter, 120_000))
        opts.onStatus?.({ kind: 'retry', attempt, maxAttempts, delayMs, message: toHfError(err).message })
        await sleep(delayMs, undefined, { signal }).catch(() => {
          throw abortReason(signal)
        })
        continue
      } finally {
        clearTimeout(stallTimer)
        if (fh) await fh.close().catch(() => undefined)
      }
    }

    // Файл получен целиком: проверки и переименование.
    const finalSize = (await statSize(part)) ?? 0
    if (finalSize !== spec.size) {
      await fs.rm(part, { force: true })
      throw new HfError(
        `Размер скачанного файла (${finalSize} Б) не совпадает с ожидаемым (${spec.size} Б).`,
        'integrity'
      )
    }
    let verified = false
    if (expectedSha) {
      let digest: string
      if (hash && hashed === spec.size) {
        digest = hash.digest('hex')
      } else {
        opts.onStatus?.({ kind: 'verify', done: 0, total: spec.size })
        digest = await hashFile(part, signal, (done) => opts.onStatus?.({ kind: 'verify', done, total: spec.size }))
      }
      hash = null
      if (digest !== expectedSha) {
        await fs.rm(part, { force: true })
        if (!checksumRestarted) {
          checksumRestarted = true
          continue
        }
        throw new HfError('Контрольная сумма SHA256 не совпала: файл повреждён при загрузке.', 'integrity')
      }
      verified = true
    }
    await fs.rm(spec.target, { force: true })
    await renameRetry(part, spec.target)
    opts.onBytes?.(spec.size)
    return { skipped: false, verified }
  }
}

/** Антивирус на Windows ненадолго блокирует свежий файл — несколько попыток. */
async function renameRetry(from: string, to: string): Promise<void> {
  for (let i = 0; ; i++) {
    try {
      await fs.rename(from, to)
      return
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      if (i >= 4 || (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES')) throw e
      await sleep(200 * (i + 1))
    }
  }
}

function sizeChanged(actual: number, expected: number): HfError {
  return new HfError(
    `Размер файла на сервере (${formatSize(actual)}) не совпадает с ожидаемым (${formatSize(expected)}). Обновите список вариантов модели.`,
    'integrity'
  )
}
