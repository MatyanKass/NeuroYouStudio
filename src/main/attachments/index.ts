import { dialog, nativeImage } from 'electron'
import { promises as fs } from 'node:fs'
import { basename, extname, isAbsolute, join } from 'node:path'
import type { Attachment } from '@shared/types'
import { attachmentsDir } from '../paths'
import { newId } from '../util/id'
import { handle } from '../ipc'
import { extractDocumentText } from './extract'
import { isInsideDir, safeFileName } from './safe'

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp'])
const MAX_FILE_BYTES = 64 * 1024 * 1024

const MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
}

function kindOf(name: string): Attachment['kind'] {
  return IMAGE_EXT.has(extname(name).toLowerCase()) ? 'image' : 'document'
}

/** Файл вложения должен лежать в папке вложений (путь приходит из интерфейса и файла диалога). */
export function assertStoredAttachment(att: Attachment): void {
  if (!isInsideDir(attachmentsDir(), att?.storedPath)) throw new Error(`Вложение «${att?.name ?? '?'}» недоступно`)
}

async function store(name: string, data: Buffer, mime?: string): Promise<Attachment> {
  if (data.length > MAX_FILE_BYTES) throw new Error(`Файл «${name}» больше 64 МБ`)
  const id = newId('a')
  const storedPath = join(attachmentsDir(), `${id}-${safeFileName(name)}`)
  await fs.writeFile(storedPath, data)
  const kind = kindOf(name)
  const att: Attachment = {
    id,
    kind,
    name,
    mime: mime || MIME[extname(name).toLowerCase()] || 'text/plain',
    storedPath,
    sizeBytes: data.length
  }
  if (kind === 'document') {
    try {
      const text = await extractDocumentText(att)
      att.textChars = text.length
    } catch (e) {
      // Нечитаемый документ не прикрепляем — и копию не оставляем.
      await fs.rm(storedPath, { force: true }).catch(() => undefined)
      throw e
    }
  }
  return att
}

export async function addAttachments(paths: string[]): Promise<Attachment[]> {
  if (!Array.isArray(paths)) throw new Error('Некорректный список файлов')
  const out: Attachment[] = []
  for (const p of paths) {
    if (typeof p !== 'string' || !isAbsolute(p)) throw new Error('Некорректный путь к файлу')
    const st = await fs.stat(p).catch(() => null)
    if (!st?.isFile()) throw new Error(`Файл не найден: ${basename(p)}`)
    // Размер — до чтения: перетащенная в чат модель на 10 ГБ не должна читаться в память.
    if (st.size > MAX_FILE_BYTES) throw new Error(`Файл «${basename(p)}» больше 64 МБ`)
    out.push(await store(basename(p), await fs.readFile(p)))
  }
  return out
}

/**
 * Картинка как data URL, уменьшенная до maxDim по большей стороне.
 * GIF/BMP/WebP перекодируются в PNG, фото — в JPEG.
 */
export async function imageDataUrl(att: Attachment, maxDim: number): Promise<string> {
  assertStoredAttachment(att)
  const img = nativeImage.createFromPath(att.storedPath)
  if (img.isEmpty()) {
    const raw = await fs.readFile(att.storedPath)
    return `data:${att.mime};base64,${raw.toString('base64')}`
  }
  const { width, height } = img.getSize()
  const scale = Math.min(1, Math.max(16, Number(maxDim) || 1024) / Math.max(width, height))
  const resized =
    scale < 1 ? img.resize({ width: Math.round(width * scale), height: Math.round(height * scale), quality: 'best' }) : img
  if (att.mime === 'image/jpeg') return `data:image/jpeg;base64,${resized.toJPEG(90).toString('base64')}`
  return `data:image/png;base64,${resized.toPNG().toString('base64')}`
}

export function registerAttachmentsIpc(): void {
  handle('attachments:pick', async () => {
    const res = await dialog.showOpenDialog({
      title: 'Прикрепить файлы',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'Документы и изображения', extensions: ['pdf', 'docx', 'txt', 'md', 'png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'csv', 'json', 'html', 'xml', 'py', 'js', 'ts', 'tsx', 'cs', 'cpp', 'c', 'h', 'java', 'go', 'rs', 'lua', 'yaml', 'yml', 'ini', 'log'] },
        { name: 'Все файлы', extensions: ['*'] }
      ]
    })
    return res.canceled ? [] : res.filePaths
  })
  handle('attachments:add', (paths) => addAttachments(paths))
  handle('attachments:addData', (name, mime, base64) => {
    if (typeof name !== 'string' || typeof base64 !== 'string') throw new Error('Некорректное вложение')
    // base64 длиннее 4/3 лимита — заведомо больше 64 МБ, не декодируем.
    if (base64.length > Math.ceil((MAX_FILE_BYTES * 4) / 3) + 4) throw new Error(`Файл «${name}» больше 64 МБ`)
    return store(name || 'файл', Buffer.from(base64, 'base64'), typeof mime === 'string' ? mime : undefined)
  })
  handle('attachments:preview', (att, maxDim) => imageDataUrl(att, maxDim))
}
