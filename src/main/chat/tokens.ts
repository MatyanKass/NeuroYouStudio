import { createHash } from 'node:crypto'
import type { ActiveEngine } from '../engines/manager'
import { authHeaders } from '../engines/auth'

// Подсчёт токенов через движок (/tokenize у llama-server, /v1/token/encode у TabbyAPI).

const cache = new Map<string, number>()
const CACHE_LIMIT = 4000

export const estimateTokens = (text: string): number => Math.ceil(text.length / 3.2)

/** Нижняя оценка числа токенов: даже очень «плотный» текст редко даёт больше ~16 символов на токен. */
export const minTokens = (text: string): number => Math.floor(text.length / 16)

/** Длинные тексты (документы) в ключе кэша — только хэшем, чтобы кэш не держал мегабайты строк. */
function cacheKey(eng: ActiveEngine, text: string): string {
  const body = text.length > 256 ? `${text.length}:${createHash('sha1').update(text).digest('hex')}` : text
  return `${eng.baseUrl}|${body}`
}

export async function countTokens(eng: ActiveEngine | null, text: string): Promise<number> {
  if (!text) return 0
  if (!eng) return estimateTokens(text)
  const key = cacheKey(eng, text)
  const hit = cache.get(key)
  if (hit !== undefined) return hit
  let n: number | undefined
  try {
    const headers = { 'Content-Type': 'application/json', ...authHeaders(eng.apiKey) }
    if (eng.engine === 'exl3') {
      const r = await fetch(`${eng.baseUrl}/v1/token/encode`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ text, add_bos_token: false }),
        signal: AbortSignal.timeout(15000)
      })
      if (r.ok) {
        const j = (await r.json()) as { length?: number; tokens?: unknown[] }
        n = j.length ?? j.tokens?.length
      } else {
        await r.body?.cancel().catch(() => undefined)
      }
    } else {
      const r = await fetch(`${eng.baseUrl}/tokenize`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ content: text, add_special: false }),
        signal: AbortSignal.timeout(15000)
      })
      if (r.ok) {
        const j = (await r.json()) as { tokens?: unknown[] }
        n = j.tokens?.length
      } else {
        await r.body?.cancel().catch(() => undefined)
      }
    }
  } catch {
    // движок недоступен — оценка ниже
  }
  // Оценку не кэшируем: в следующий раз движок может ответить.
  if (typeof n !== 'number') return estimateTokens(text)
  if (cache.size > CACHE_LIMIT) cache.clear()
  cache.set(key, n)
  return n
}
