import { promises as fs } from 'node:fs'
import { dirname } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

export async function readJson<T>(path: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await fs.readFile(path, 'utf8')) as T
  } catch {
    return fallback
  }
}

let tmpSeq = 0
/** Очередь записей по пути: последняя запись всегда ложится на диск последней. */
const chains = new Map<string, Promise<void>>()

/** Антивирус/индексатор на Windows ненадолго блокирует свежий файл — несколько попыток. */
async function renameRetry(from: string, to: string): Promise<void> {
  for (let i = 0; ; i++) {
    try {
      await fs.rename(from, to)
      return
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      if (i >= 4 || (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES')) throw e
      await sleep(50 * (i + 1))
    }
  }
}

async function writeNow(path: string, text: string): Promise<void> {
  await fs.mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.${Date.now()}.${++tmpSeq}.tmp`
  try {
    await fs.writeFile(tmp, text, 'utf8')
    await renameRetry(tmp, path)
  } catch (e) {
    await fs.rm(tmp, { force: true }).catch(() => undefined)
    throw e
  }
}

/** Атомарная запись: во временный файл и rename поверх. Записи в один файл выполняются по очереди. */
export function writeJson(path: string, data: unknown): Promise<void> {
  // Снимок берём сразу: объект могут изменить, пока запись ждёт очереди.
  const text = JSON.stringify(data, null, 2)
  const key = path.toLowerCase()
  const prev = chains.get(key) ?? Promise.resolve()
  const next = prev.catch(() => undefined).then(() => writeNow(path, text))
  chains.set(key, next)
  void next
    .catch(() => undefined)
    .finally(() => {
      if (chains.get(key) === next) chains.delete(key)
    })
  return next
}
