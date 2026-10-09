// Реестр локальных моделей: сканирование папки моделей, кэш метаданных, IPC models:*.
import { join } from 'node:path'
import type { LocalModel } from '@shared/types'
import { emit, handle } from '../ipc'
import { userDataDir } from '../paths'
import { getSettings } from '../settings'
import { readJson, writeJson } from '../util/json-file'
import { deleteModelFiles, emptyModelCache, scanModelsDir, type ModelCache } from './scan'

const cachePath = (): string => join(userDataDir(), 'model-cache.json')

let models: LocalModel[] = []
let scanned = false
let scanning: Promise<LocalModel[]> | null = null
let queued: Promise<LocalModel[]> | null = null
let cache: ModelCache | null = null

async function doScan(): Promise<LocalModel[]> {
  cache ??= await readJson<ModelCache>(cachePath(), emptyModelCache())
  const res = await scanModelsDir(getSettings().modelsDir, cache)
  cache = res.cache
  if (res.cacheChanged) await writeJson(cachePath(), cache).catch(() => undefined)
  models = res.models
  scanned = true
  emit('models:changed', models)
  return models
}

/** Пересканирование. Запросы во время идущего скана склеиваются в один следующий проход. */
function rescan(): Promise<LocalModel[]> {
  if (!scanning) {
    scanning = doScan().finally(() => {
      scanning = null
    })
    return scanning
  }
  queued ??= scanning
    .catch(() => undefined)
    .then(() => {
      queued = null
      return rescan()
    })
  return queued
}

/** Список локальных моделей (кэш; rescan — пересканировать папку). */
export async function listModels(rescanDir = false): Promise<LocalModel[]> {
  if (!rescanDir && scanned) return models
  return rescan()
}

export function getModel(id: string): LocalModel | undefined {
  return models.find((m) => m.id === id)
}

export async function deleteModel(id: string): Promise<void> {
  if (!scanned) await listModels()
  const m = getModel(id)
  if (!m) throw new Error(`Модель не найдена: ${id}`)
  try {
    await deleteModelFiles(getSettings().modelsDir, m)
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    if (code === 'EBUSY' || code === 'EPERM') {
      throw new Error('Файл модели занят — выгрузите модель (или закройте программу, которая её держит) и повторите.', {
        cause: e
      })
    }
    throw e
  } finally {
    await listModels(true)
  }
}

/** Регистрирует IPC: models:list, models:delete. */
export function registerModelsIpc(): void {
  handle('models:list', (rescanDir) => listModels(rescanDir ?? false))
  handle('models:delete', (modelId) => deleteModel(modelId))
  // первый скан в фоне, чтобы getModel() работал сразу после старта
  void listModels().catch((e: unknown) => console.error('[models] не удалось просканировать папку моделей:', e))
}
