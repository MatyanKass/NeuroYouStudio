import type { Attachment } from '@shared/types'
import type { ActiveEngine } from '../engines/manager'
import { getSettings } from '../settings'
import { countTokens, minTokens } from '../chat/tokens'
import { extractDocumentText } from './extract'
import { bm25, chunkText } from './rag'

export interface DocumentContext {
  text: string
  mode: 'full' | 'rag'
  citations: Array<{ attachmentId: string; text: string; score: number }>
}

export interface RagOptions {
  chunkSize: number
  chunkOverlap: number
  topK: number
}

/** Сколько кандидатов (сверх topK) просматривать при наборе фрагментов: каждый — запрос /tokenize. */
const SCAN_FACTOR = 4

/**
 * Как в LM Studio: если документы помещаются в контекст — вставляем целиком,
 * иначе подставляем наиболее релевантные запросу фрагменты (RAG).
 */
export async function buildDocumentContext(
  docs: Attachment[],
  query: string,
  budgetTokens: number,
  eng: ActiveEngine | null,
  extract: (a: Attachment) => Promise<string> = extractDocumentText,
  rag?: RagOptions
): Promise<DocumentContext> {
  const texts = await Promise.all(docs.map(async (d) => ({ doc: d, text: await extract(d) })))
  const full = texts.map((t) => `[Документ: ${t.doc.name}]\n${t.text}`).join('\n\n')
  // Заведомо не влезающий документ не отправляем в /tokenize целиком.
  if (minTokens(full) <= budgetTokens && (await countTokens(eng, full)) <= budgetTokens) {
    return { text: full, mode: 'full', citations: [] }
  }

  const s = rag ?? {
    chunkSize: getSettings().ragChunkSize,
    chunkOverlap: getSettings().ragChunkOverlap,
    topK: getSettings().ragTopK
  }
  const topK = Math.max(1, s.topK)
  const pool = texts.flatMap((t) => chunkText(t.text, s.chunkSize, s.chunkOverlap).map((c) => ({ ...c, doc: t.doc })))
  const scores = bm25(pool, query)
  const ranked = pool.map((c, i) => ({ c, score: scores[i] ?? 0 })).sort((a, b) => b.score - a.score)
  const picked: typeof ranked = []
  let used = 0
  let scanned = 0
  for (const r of ranked) {
    if (picked.length >= topK || scanned >= topK * SCAN_FACTOR || r.score <= 0) break
    scanned++
    const t = await countTokens(eng, r.c.text)
    if (used + t > budgetTokens) continue
    picked.push(r)
    used += t
  }
  // Если по словам ничего не нашлось («перескажи документ») — берём начало документов, сколько влезет.
  if (!picked.length) {
    used = 0
    for (const c of pool) {
      const t = await countTokens(eng, c.text)
      if (used + t > budgetTokens) break
      picked.push({ c, score: 0 })
      used += t
    }
  }
  // Порядок документов и фрагментов внутри документа — как в исходниках.
  const docOrder = new Map(docs.map((d, i) => [d.id, i]))
  picked.sort((a, b) => (docOrder.get(a.c.doc.id) ?? 0) - (docOrder.get(b.c.doc.id) ?? 0) || a.c.index - b.c.index)
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
