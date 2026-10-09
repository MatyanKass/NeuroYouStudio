import type { ActiveEngine } from '../engines/manager'

// Подсчёт токенов через движок (/tokenize у llama-server, /v1/token/encode у TabbyAPI).

const cache = new Map<string, number>()
const CACHE_LIMIT = 4000

export const estimateTokens = (text: string): number => Math.ceil(text.length / 3.2)

export async function countTokens(eng: ActiveEngine | null, text: string): Promise<number> {
  if (!text) return 0
  if (!eng) return estimateTokens(text)
  const key = `${eng.baseUrl}|${text}`
  const hit = cache.get(key)
  if (hit !== undefined) return hit
  let n: number
  try {
    if (eng.engine === 'exl3') {
      const r = await fetch(`${eng.baseUrl}/v1/token/encode`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, add_bos_token: false }),
        signal: AbortSignal.timeout(15000)
      })
      const j = (await r.json()) as { length?: number; tokens?: unknown[] }
      n = j.length ?? j.tokens?.length ?? estimateTokens(text)
    } else {
      const r = await fetch(`${eng.baseUrl}/tokenize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: text, add_special: false }),
        signal: AbortSignal.timeout(15000)
      })
      const j = (await r.json()) as { tokens?: unknown[] }
      n = j.tokens?.length ?? estimateTokens(text)
    }
  } catch {
    return estimateTokens(text)
  }
  if (cache.size > CACHE_LIMIT) cache.clear()
  cache.set(key, n)
  return n
}
