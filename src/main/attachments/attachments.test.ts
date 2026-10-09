import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import type { Attachment } from '@shared/types'

vi.mock('electron', () => ({ app: { getPath: () => tmpdir() }, safeStorage: {}, ipcMain: {}, BrowserWindow: {} }))

const { buildDocumentContext } = await import('./documents')
const { decodeText, extractDocumentText, looksBinary } = await import('./extract')
const { isInsideDir, safeFileName } = await import('./safe')

const dir = mkdtempSync(join(tmpdir(), 'nys-att-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const doc = (id: string, name = `${id}.txt`): Attachment => ({
  id,
  kind: 'document',
  name,
  mime: 'text/plain',
  storedPath: join(dir, name),
  sizeBytes: 0
})

/** Минимальный PDF с одной страницей; text = null — страница без текста (как скан). */
function makePdf(text: string | null): Buffer {
  const content = text ? `BT /F1 24 Tf 72 720 Td (${text}) Tj ET` : ''
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
  ]
  let out = '%PDF-1.4\n'
  const offs: number[] = []
  objs.forEach((o, i) => {
    offs.push(out.length)
    out += `${i + 1} 0 obj\n${o}\nendobj\n`
  })
  const xref = out.length
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offs.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(out, 'latin1')
}

describe('извлечение текста', () => {
  it('UTF-8, UTF-16 LE/BE с BOM и Windows-1251 без BOM', () => {
    expect(decodeText(Buffer.from('Привет', 'utf8'))).toBe('Привет')
    expect(decodeText(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('Привет', 'utf16le')]))).toBe('Привет')
    expect(decodeText(Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from('Привет', 'utf16le').swap16()]))).toBe('Привет')
    // «Привет» в cp1251
    expect(decodeText(Buffer.from([0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2]))).toBe('Привет')
  })
  it('UTF-16 с BOM не считается двоичным, файл с нулями — считается', () => {
    expect(looksBinary(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('ab', 'utf16le')]))).toBe(false)
    expect(looksBinary(Buffer.from([0x4d, 0x5a, 0x00, 0x01]))).toBe(true)
  })
  it('PDF: текст по страницам (unpdf), скан без текста — понятная ошибка', async () => {
    writeFileSync(join(dir, 'a.pdf'), makePdf('Hello PDF'))
    writeFileSync(join(dir, 'scan.pdf'), makePdf(null))
    expect(await extractDocumentText(doc('p1', 'a.pdf'))).toContain('Hello PDF')
    await expect(extractDocumentText(doc('p2', 'scan.pdf'))).rejects.toThrow(/нет текстового слоя/)
  })
  it('пропавший файл — понятная ошибка', async () => {
    await expect(extractDocumentText(doc('nope', 'nope.txt'))).rejects.toThrow(/не найден/)
  })
})

describe('buildDocumentContext', () => {
  const rag = { chunkSize: 60, chunkOverlap: 0, topK: 3 }
  const texts: Record<string, string> = {
    d1: Array.from({ length: 40 }, (_, i) => `Абзац ${i} про погоду и облака.`).join('\n\n'),
    d2: Array.from({ length: 40 }, (_, i) => `Раздел ${i}: настройка видеокарты и драйвера.`).join('\n\n')
  }
  const extract = async (a: Attachment): Promise<string> => texts[a.id] ?? ''

  it('влезает — целиком', async () => {
    const r = await buildDocumentContext([doc('d1')], 'вопрос', 100_000, null, extract, rag)
    expect(r.mode).toBe('full')
  })
  it('не влезает — только релевантные фрагменты, в порядке документов и фрагментов', async () => {
    const r = await buildDocumentContext([doc('d1'), doc('d2')], 'видеокарты драйвера облака', 300, null, extract, rag)
    expect(r.mode).toBe('rag')
    expect(r.citations.length).toBeGreaterThan(0)
    expect(r.citations.length).toBeLessThanOrEqual(3)
    const order = r.citations.map((c) => c.attachmentId)
    // все фрагменты d1 идут раньше фрагментов d2
    expect(order.join(',')).toMatch(/^(d1,)*(d2,?)*$/)
  })
  it('нет совпадений по словам — начало документа, сколько влезет', async () => {
    const r = await buildDocumentContext([doc('d1')], 'перескажи', 120, null, extract, rag)
    expect(r.mode).toBe('rag')
    expect(r.citations.length).toBeGreaterThan(0)
    expect(r.text).toContain('Абзац 0')
  })
})

describe('пути вложений', () => {
  it('только внутри папки вложений', () => {
    const root = join(dir, 'attachments')
    expect(isInsideDir(root, join(root, 'a.png'))).toBe(true)
    expect(isInsideDir(root, join(root, '..', 'settings.json'))).toBe(false)
    expect(isInsideDir(root, root)).toBe(false)
    expect(isInsideDir(root, 'relative.png')).toBe(false)
    expect(isInsideDir(root, undefined)).toBe(false)
  })
  it('имя файла без запрещённых символов и не длиннее 100', () => {
    expect(safeFileName('a<b>:c?.txt')).toBe('a_b__c_.txt')
    const long = safeFileName(`${'я'.repeat(300)}.pdf`)
    expect(long.length).toBe(100)
    expect(long.endsWith('.pdf')).toBe(true)
  })
})
