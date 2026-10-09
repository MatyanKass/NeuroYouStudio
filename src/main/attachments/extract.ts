import { promises as fs } from 'node:fs'
import { extname } from 'node:path'
import type { Attachment } from '@shared/types'

// Извлечение текста из документов: pdf (unpdf), docx (mammoth), всё текстовое — как есть.

/** Небольшой LRU: извлечённые тексты бывают по десятку мегабайт. */
const textCache = new Map<string, string>()
const TEXT_CACHE_LIMIT = 32

async function pdfText(buf: Buffer): Promise<string> {
  const { extractText, getDocumentProxy } = await import('unpdf')
  const pdf = await getDocumentProxy(new Uint8Array(buf))
  const { text } = await extractText(pdf, { mergePages: false })
  const pages = Array.isArray(text) ? text : [text]
  if (!pages.some((t) => t.trim())) {
    throw new Error('в PDF нет текстового слоя (похоже на скан) — распознайте текст (OCR) и прикрепите снова')
  }
  return pages.map((t, i) => `--- Страница ${i + 1} ---\n${t}`).join('\n\n')
}

async function docxText(buf: Buffer): Promise<string> {
  const mammoth = await import('mammoth')
  const res = await mammoth.extractRawText({ buffer: buf })
  return res.value
}

/** UTF-8/UTF-16 по BOM; без BOM — UTF-8, а если он невалиден — Windows-1251 (старые русские .txt). */
export function decodeText(buf: Buffer): string {
  if (buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString('utf16le')
  if (buf[0] === 0xfe && buf[1] === 0xff) {
    // UTF-16 BE → LE: меняем байты местами (нечётный хвост отбрасываем).
    const le = Buffer.from(buf.subarray(2, 2 + ((buf.length - 2) & ~1)))
    return le.swap16().toString('utf16le')
  }
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return buf.subarray(3).toString('utf8')
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf)
  } catch {
    try {
      return new TextDecoder('windows-1251').decode(buf)
    } catch {
      return buf.toString('utf8')
    }
  }
}

/** Похоже на двоичный файл: нулевые байты (кроме UTF-16 с BOM). */
export function looksBinary(buf: Buffer): boolean {
  const utf16 = (buf[0] === 0xff && buf[1] === 0xfe) || (buf[0] === 0xfe && buf[1] === 0xff)
  return !utf16 && buf.subarray(0, 8000).includes(0)
}

export async function extractDocumentText(att: Attachment): Promise<string> {
  const hit = textCache.get(att.storedPath)
  if (hit !== undefined) {
    textCache.delete(att.storedPath)
    textCache.set(att.storedPath, hit)
    return hit
  }
  const buf = await fs.readFile(att.storedPath).catch(() => {
    throw new Error(`Файл «${att.name}» не найден — прикрепите его заново`)
  })
  const ext = extname(att.name).toLowerCase()
  let text: string
  try {
    if (ext === '.pdf') text = await pdfText(buf)
    else if (ext === '.docx') text = await docxText(buf)
    else {
      // Бинарные файлы не читаем как текст.
      if (looksBinary(buf)) throw new Error('файл не похож на текстовый')
      text = decodeText(buf)
    }
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e)
    throw new Error(`Не удалось прочитать «${att.name}»: ${why}`, { cause: e })
  }
  text = text.replace(/\r\n/g, '\n').replace(/\n{4,}/g, '\n\n\n').trim()
  if (textCache.size >= TEXT_CACHE_LIMIT) textCache.delete(textCache.keys().next().value as string)
  textCache.set(att.storedPath, text)
  return text
}
