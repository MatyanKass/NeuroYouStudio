import type { Attachment } from '@shared/types'
import { call } from './api'

// llama.cpp понимает только PNG/JPEG, а main (nativeImage) не умеет декодировать WebP/GIF/BMP.
// Такие картинки перекодируем здесь, средствами Chromium, в PNG.
const NEEDS_PNG = new Set(['image/webp', 'image/gif', 'image/bmp'])

function dataUrlToBlob(url: string): Blob {
  const [head, b64 = ''] = url.split(',')
  const mime = /data:([^;]+)/.exec(head ?? '')?.[1] ?? 'application/octet-stream'
  const bin = atob(b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return new Blob([bytes], { type: mime })
}

async function toPngBase64(blob: Blob): Promise<string> {
  const bmp = await createImageBitmap(blob)
  const canvas = document.createElement('canvas')
  canvas.width = bmp.width
  canvas.height = bmp.height
  canvas.getContext('2d')!.drawImage(bmp, 0, 0)
  bmp.close()
  return canvas.toDataURL('image/png').split(',')[1] ?? ''
}

/** Заменяет WebP/GIF/BMP на PNG-копии; остальные вложения возвращает как есть. */
export async function normalizeImages(atts: Attachment[]): Promise<Attachment[]> {
  const out: Attachment[] = []
  for (const a of atts) {
    if (a.kind !== 'image' || !NEEDS_PNG.has(a.mime)) {
      out.push(a)
      continue
    }
    try {
      const raw = await call('attachments:preview', a, 100_000)
      const png = await toPngBase64(dataUrlToBlob(raw))
      out.push(await call('attachments:addData', a.name.replace(/\.\w+$/, '') + '.png', 'image/png', png))
    } catch {
      out.push(a)
    }
  }
  return out
}
