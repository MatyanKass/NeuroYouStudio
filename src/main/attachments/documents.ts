import type { Attachment } from '@shared/types'
import type { ActiveEngine } from '../engines/manager'
import { getSettings } from '../settings'
import { countTokens } from '../chat/tokens'
import { extractDocumentText } from './extract'
import { bm25, chunkText } from './rag'

export interface DocumentContext {
  text: string
  mode: 'full' | 'rag'
  citations: Array<{ attachmentId: string; text: string; score: number }>
}

/**
 * Как в LM Studio: если документы помещаются в контекст — вставляем целиком,
 * иначе подставляем наиболее релевантные запросу фрагменты (RAG).
 */
export async function buildDocumentContext(
  docs: Attachment[],
  query: string,
  budgetTokens: number,
  eng: ActiveEngine
): Promise<DocumentContext> {
  const texts = await Promise.all(docs.map(async (d) => ({ doc: d, text: await extractDocumentText(d) })))
  const full = texts.map((t) => `[Документ: ${t.doc.name}]\n${t.text}`).join('\n\n')
  const fullTokens = await countTokens(eng, full)
  if (fullTokens <= budgetTokens) return { text: full, mode: 'full', citations: [] }

  const s = getSettings()
  const pool = texts.flatMap((t) =>
    chunkText(t.text, s.ragChunkSize, s.ragChunkOverlap).map((c) => ({ ...c, doc: t.doc }))
  )
  const scores = bm25(pool, query)
  const ranked = pool.map((c, i) => ({ c, score: scores[i] ?? 0 })).sort((a, b) => b.score - a.score)
  const picked: typeof ranked = []
  let used = 0
  for (const r of ranked) {
    if (picked.length >= Math.max(1, s.ragTopK)) break
    const t = await countTokens(eng, r.c.text)
    if (used + t > budgetTokens) continue
    picked.push(r)
    used += t
  }
  // Если по словам ничего не нашлось — берём начало документов.
  if (!picked.length || picked.every((p) => p.score === 0)) {
    picked.length = 0
    used = 0
    for (const c of pool) {
      const t = await countTokens(eng, c.text)
      if (used + t > budgetTokens) break
      picked.push({ c, score: 0 })
      used += t
    }
  }
  picked.sort((a, b) => (a.c.doc.id === b.c.doc.id ? a.c.index - b.c.index : 0))
  const text = [
    'Ниже — фрагменты прикреплённых документов, наиболее относящиеся к вопросу:',
    ...picked.map((p) => `[${p.c.doc.name}, фрагмент ${p.c.index + 1}]\n${p.c.text}`)
  ].join('\n\n')
  return {
    text,
    mode: 'rag',
    citations: picked.map((p) => ({ attachmentId: p.c.doc.id, text: p.c.text.slice(0, 400), score: p.score }))
  }
}
