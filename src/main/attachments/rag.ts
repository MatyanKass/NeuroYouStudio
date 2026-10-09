// Нарезка текста на чанки и лексический поиск (BM25) — работает без модели эмбеддингов.

export interface Chunk {
  text: string
  index: number
}

const CHARS_PER_TOKEN = 3.2

/** Чанки ~chunkTokens токенов с перекрытием, по границам абзацев/предложений где возможно. */
export function chunkText(text: string, chunkTokens: number, overlapTokens: number): Chunk[] {
  const size = Math.max(200, Math.round(chunkTokens * CHARS_PER_TOKEN))
  const overlap = Math.min(Math.round(overlapTokens * CHARS_PER_TOKEN), Math.floor(size / 2))
  const chunks: Chunk[] = []
  let pos = 0
  while (pos < text.length) {
    let end = Math.min(text.length, pos + size)
    if (end < text.length) {
      const window = text.slice(pos + Math.floor(size * 0.6), end)
      const brk = Math.max(window.lastIndexOf('\n\n'), window.lastIndexOf('. '), window.lastIndexOf('\n'))
      if (brk > 0) end = pos + Math.floor(size * 0.6) + brk + 1
    }
    const piece = text.slice(pos, end).trim()
    if (piece) chunks.push({ text: piece, index: chunks.length })
    if (end >= text.length) break
    pos = Math.max(end - overlap, pos + 1)
  }
  return chunks
}

export function tokenizeWords(s: string): string[] {
  return (s.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? []).map((w) =>
    // Грубая нормализация окончаний, чтобы «модели»/«модель» совпадали.
    w.length > 5 ? w.slice(0, w.length - 2) : w
  )
}

/** BM25-оценки чанков для запроса. */
export function bm25(chunks: Chunk[], query: string, k1 = 1.4, b = 0.75): number[] {
  const docs = chunks.map((c) => tokenizeWords(c.text))
  const avgLen = docs.reduce((s, d) => s + d.length, 0) / Math.max(1, docs.length)
  const df = new Map<string, number>()
  for (const d of docs) for (const w of new Set(d)) df.set(w, (df.get(w) ?? 0) + 1)
  const q = [...new Set(tokenizeWords(query))]
  const N = docs.length
  return docs.map((d) => {
    const tf = new Map<string, number>()
    for (const w of d) tf.set(w, (tf.get(w) ?? 0) + 1)
    let score = 0
    for (const w of q) {
      const f = tf.get(w)
      if (!f) continue
      const n = df.get(w) ?? 0
      const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5))
      score += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * d.length) / Math.max(1, avgLen))))
    }
    return score
  })
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!
    na += a[i]! * a[i]!
    nb += b[i]! * b[i]!
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0
}
