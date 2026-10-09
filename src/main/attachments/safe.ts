import { extname, isAbsolute, relative, resolve } from 'node:path'

// Проверки путей вложений (без Electron — для тестов).

/** p лежит внутри dir (не сама папка, без выхода через ..). */
export function isInsideDir(dir: string, p: unknown): boolean {
  if (typeof p !== 'string' || !isAbsolute(p)) return false
  const r = relative(resolve(dir), resolve(p))
  return r !== '' && !r.startsWith('..') && !isAbsolute(r)
}

const FORBIDDEN = '<>:"/\\|?*'
const MAX_NAME = 100

/** Имя файла без запрещённых в Windows символов и не слишком длинное (MAX_PATH). */
export function safeFileName(name: string): string {
  const safe = [...name].map((ch) => (ch.charCodeAt(0) < 32 || FORBIDDEN.includes(ch) ? '_' : ch)).join('')
  if (safe.length <= MAX_NAME) return safe
  const ext = extname(safe).slice(0, 16)
  return safe.slice(0, MAX_NAME - ext.length) + ext
}
