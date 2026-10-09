// Загрузка файла с докачкой (Range) и проверкой SHA256. Без electron.
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream, promises as fs } from 'node:fs'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { ReadableStream as WebReadableStream } from 'node:stream/web'

export interface DownloadOptions {
  url: string
  /** Итоговый путь. Пока идёт загрузка, данные пишутся в `${dest}.part`. */
  dest: string
  sha256?: string
  size?: number
  signal?: AbortSignal
  /** received — сколько байт файла уже есть (с учётом докачки). */
  onProgress?: (received: number, total: number) => void
  retries?: number
}

export async function sha256File(path: string, signal?: AbortSignal): Promise<string> {
  const hash = createHash('sha256')
  await pipeline(createReadStream(path, { highWaterMark: 1 << 20 }), hash, { signal })
  return hash.digest('hex')
}

async function fileSize(path: string): Promise<number> {
  try {
    return (await fs.stat(path)).size
  } catch {
    return 0
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** Скачивает файл; если он уже скачан и хэш совпадает — ничего не делает. */
export async function downloadFile(opts: DownloadOptions): Promise<void> {
  const { url, dest, sha256, signal, onProgress } = opts
  const part = `${dest}.part`
  const expected = sha256?.toLowerCase()

  if (opts.size && (await fileSize(dest)) === opts.size) {
    if (!expected || (await sha256File(dest, signal)) === expected) {
      onProgress?.(opts.size, opts.size)
      return
    }
    await fs.rm(dest, { force: true })
  }

  new URL(url) // некорректный адрес — сразу ошибка, без повторов
  const retries = opts.retries ?? 5
  let total = opts.size ?? 0
  for (let attempt = 0; ; attempt++) {
    signal?.throwIfAborted()
    try {
      total = await fetchToPart(url, part, total, signal, onProgress)
      break
    } catch (e) {
      if (signal?.aborted || attempt >= retries || (e as { fatal?: boolean }).fatal) throw e
      await sleep(Math.min(1000 * 2 ** attempt, 15000))
    }
  }

  if (opts.size && (await fileSize(part)) !== opts.size) {
    await fs.rm(part, { force: true })
    throw new Error(`Размер файла не совпал: ${url}`)
  }
  if (expected) {
    const got = await sha256File(part, signal)
    if (got !== expected) {
      await fs.rm(part, { force: true })
      throw new Error(`Контрольная сумма не совпала (${dest.split(/[\\/]/).pop()}): файл повреждён, повторите загрузку`)
    }
  }
  await fs.rm(dest, { force: true })
  await fs.rename(part, dest)
}

async function fetchToPart(
  url: string,
  part: string,
  knownTotal: number,
  signal: AbortSignal | undefined,
  onProgress: DownloadOptions['onProgress']
): Promise<number> {
  let have = await fileSize(part)
  if (knownTotal && have > knownTotal) {
    await fs.rm(part, { force: true })
    have = 0
  }
  if (knownTotal && have === knownTotal) return knownTotal

  const headers: Record<string, string> = { 'User-Agent': 'NeuroYouStudio' }
  if (have > 0) headers.Range = `bytes=${have}-`
  const res = await fetch(url, { headers, redirect: 'follow', signal })

  if (res.status === 416) {
    // Сервер считает, что всё уже скачано.
    return have
  }
  if (!res.ok || !res.body) {
    const err = new Error(`Ошибка загрузки ${res.status} ${res.statusText}: ${url}`) as Error & { fatal?: boolean }
    err.fatal = res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429
    throw err
  }

  const append = res.status === 206
  if (!append) have = 0
  const len = Number(res.headers.get('content-length') ?? 0)
  const total = knownTotal || (len ? have + len : 0)

  let received = have
  let lastEmit = 0
  const counter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      received += chunk.length
      const now = Date.now()
      if (now - lastEmit > 200) {
        lastEmit = now
        onProgress?.(received, total)
      }
      cb(null, chunk)
    }
  })
  await pipeline(
    Readable.fromWeb(res.body as unknown as WebReadableStream),
    counter,
    createWriteStream(part, { flags: append ? 'a' : 'w' }),
    { signal }
  )
  onProgress?.(received, total)
  return total || received
}
