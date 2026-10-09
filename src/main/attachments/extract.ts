import { promises as fs } from 'node:fs'
import { extname } from 'node:path'
import type { Attachment } from '@shared/types'

// Извлечение текста из документов: pdf (unpdf), docx (mammoth), всё текстовое — как есть.

const textCache = new Map<string, string>()

async function pdfText(buf: Buffer): Promise<string> {
  const { extractText, getDocumentProxy } = await import('unpdf')
  const pdf = await getDocumentProxy(new Uint8Array(buf))
  const { text } = await extractText(pdf, { mergePages: false })
  return (Array.isArray(text) ? text : [text]).map((t, i) => `--- Страница ${i + 1} ---\n${t}`).join('\n\n')
}

async function docxText(buf: Buffer): Promise<string> {
  const mammoth = await import('mammoth')
  const res = await mammoth.extractRawText({ buffer: buf })
  return res.value
}

function decodeText(buf: Buffer): string {
  // UTF-8 с BOM / UTF-16 LE с BOM; иначе UTF-8.
  if (buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString('utf16le')
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return buf.subarray(3).toString('utf8')
  return buf.toString('utf8')
}

export async function extractDocumentText(att: Attachment): Promise<string> {
  const hit = textCache.get(att.storedPath)
  if (hit !== undefined) return hit
  const buf = await fs.readFile(att.storedPath)
  const ext = extname(att.name).toLowerCase()
  let text: string
  if (ext === '.pdf') text = await pdfText(buf)
  else if (ext === '.docx') text = await docxText(buf)
  else {
    // Бинарные файлы не читаем как текст.
    if (buf.subarray(0, 8000).includes(0)) throw new Error(`Файл «${att.name}» не похож на текстовый`)
    text = decodeText(buf)
  }
  text = text.replace(/\r\n/g, '\n').replace(/\n{4,}/g, '\n\n\n').trim()
  textCache.set(att.storedPath, text)
  return text
}
