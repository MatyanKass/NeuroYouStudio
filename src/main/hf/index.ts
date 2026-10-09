// IPC «Поиск» (HuggingFace) и менеджер загрузок. Вся логика — в client/details/downloader, здесь только привязка к Electron.
import { join } from 'node:path'
import type { ModelFormat } from '@shared/config'
import { emit, handle } from '../ipc'
import { getHfToken, getSettings } from '../settings'
import { userDataDir } from '../paths'
import { getHardwareInfo } from '../hardware'
import { listModels } from '../models/registry'
import { HfClient, HfError } from './client'
import { fetchModelDetails, type DetailsResult } from './details'
import { DownloadManager, planDownload } from './downloader'

const DETAILS_TTL_MS = 10 * 60 * 1000

const client = new HfClient({ getToken: getHfToken })
const detailsCache = new Map<string, { at: number; value: DetailsResult }>()
let manager: DownloadManager | null = null
let ready: Promise<void> = Promise.resolve()

async function getDetails(repoId: string, format: ModelFormat, maxAgeMs: number): Promise<DetailsResult> {
  const key = `${repoId.toLowerCase()}|${format}`
  const cached = detailsCache.get(key)
  if (cached && Date.now() - cached.at < maxAgeMs) return cached.value
  const hardware = await getHardwareInfo().catch(() => null)
  const value = await fetchModelDetails({ client, modelsDir: getSettings().modelsDir, hardware }, repoId, format)
  detailsCache.set(key, { at: Date.now(), value })
  if (detailsCache.size > 50) detailsCache.delete(detailsCache.keys().next().value as string)
  return value
}

async function mgr(): Promise<DownloadManager> {
  await ready
  if (!manager) throw new HfError('Менеджер загрузок не запущен.', 'input')
  return manager
}

/** Регистрирует IPC hf:*, downloads:*. */
export function registerHfIpc(): void {
  manager = new DownloadManager({
    stateFile: join(userDataDir(), 'downloads.json'),
    getToken: getHfToken,
    onUpdate: (items) => emit('downloads:update', items),
    onItemDone: async () => {
      detailsCache.clear()
      // listModels(true) сам рассылает models:changed.
      await listModels(true)
    }
  })
  ready = manager.init().catch((e: unknown) => {
    console.error('[hf] не удалось восстановить очередь загрузок:', e)
  })

  handle('hf:search', (q) => client.search(q))
  handle('hf:details', (repoId, format) => getDetails(repoId, format, 0))

  handle('downloads:start', async (repoId, format, optionKey, withMmproj) => {
    const m = await mgr()
    const d = await getDetails(repoId, format, DETAILS_TTL_MS)
    const option = d.options.find((o) => o.key === optionKey) ?? d.mmproj.find((o) => o.key === optionKey)
    if (!option) throw new HfError('Вариант модели не найден — обновите список файлов.', 'notFound')
    const mmproj = withMmproj ? d.mmproj.find((o) => o.key === withMmproj) : undefined
    if (withMmproj && !mmproj) throw new HfError('Файл mmproj не найден — обновите список файлов.', 'notFound')
    m.start(planDownload(getSettings().modelsDir, d.id, format, option, mmproj))
  })
  handle('downloads:list', async () => (await mgr()).list())
  handle('downloads:pause', async (id) => (await mgr()).pause(id))
  handle('downloads:resume', async (id) => (await mgr()).resume(id))
  handle('downloads:cancel', async (id) => {
    await (await mgr()).cancel(id)
    detailsCache.clear()
  })
  handle('downloads:clearFinished', async () => (await mgr()).clearFinished())
}

export async function shutdownDownloads(): Promise<void> {
  if (!manager) return
  await ready
  await manager.shutdown()
}
