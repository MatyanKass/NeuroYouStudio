// Раздел «Движки»: список/установка/удаление/выбор сборок. Обвязка над RuntimeStore.
import type { EngineId } from '@shared/config'
import type { AppSettings, RuntimeDescriptor, TaskProgress } from '@shared/types'
import { emit, handle } from '../ipc'
import { runtimesDir, tmpDownloadsDir } from '../paths'
import { getSettings, updateSettings } from '../settings'
import { getHardwareInfo } from '../hardware'
import { RuntimeStore, type ResolvedRuntime } from './store'

export type { ResolvedRuntime } from './store'

let store: RuntimeStore | null = null
const controllers = new Map<string, AbortController>()
let inUseCheck: (id: string) => boolean = () => false

export function runtimeStore(): RuntimeStore {
  store ??= new RuntimeStore({ runtimesDir: runtimesDir(), tmpDir: tmpDownloadsDir() })
  return store
}

/** Менеджер движков сообщает, какая сборка сейчас запущена (её нельзя удалять). */
export function setRuntimeInUseCheck(fn: (id: string) => boolean): void {
  inUseCheck = fn
}

export async function listRuntimes(): Promise<RuntimeDescriptor[]> {
  return runtimeStore().list(await getHardwareInfo())
}

/** Неблокирующая установка: прогресс и итог приходят событиями runtimes:progress. */
export function installRuntime(id: string): void {
  const s = runtimeStore()
  const entry = s.entry(id)
  if (!entry) throw new Error(`Неизвестная сборка движка: ${id}`)
  if (s.isInstalling(id)) return
  const ac = new AbortController()
  controllers.set(id, ac)
  let lastEmit = 0
  let last: TaskProgress | null = null
  const send = (p: TaskProgress): void => {
    const now = Date.now()
    const force = p.done || p.phase !== last?.phase || now - lastEmit >= 250
    last = p
    if (force) {
      lastEmit = now
      emit('runtimes:progress', p)
    }
  }
  s.install(id, send, ac.signal)
    .catch((e: unknown) => {
      const msg = ac.signal.aborted ? 'Установка отменена' : e instanceof Error ? e.message : String(e)
      send({
        id,
        title: entry.title,
        phase: 'Ошибка',
        receivedBytes: last?.receivedBytes ?? 0,
        totalBytes: last?.totalBytes ?? entry.files.reduce((a, f) => a + f.size, 0),
        done: true,
        error: msg
      })
    })
    .finally(() => controllers.delete(id))
}

export function cancelRuntimeInstall(id: string): void {
  controllers.get(id)?.abort()
}

export async function removeRuntime(id: string): Promise<void> {
  if (inUseCheck(id)) throw new Error('Эта сборка сейчас используется — сначала выгрузите модель')
  const s = runtimeStore()
  if (s.isInstalling(id)) {
    cancelRuntimeInstall(id)
    throw new Error('Сборка ещё устанавливается — установка отменена, повторите удаление')
  }
  await s.remove(id)
  const engine = s.entry(id)?.engine
  if (engine && getSettings().selectedRuntimes[engine] === id) {
    // deepMerge пропускает undefined, поэтому «сбрасываем» пустой строкой.
    await updateSettings({ selectedRuntimes: { [engine]: '' } })
  }
}

export async function selectRuntime(id: string): Promise<AppSettings> {
  const entry = runtimeStore().entry(id)
  if (!entry) throw new Error(`Неизвестная сборка движка: ${id}`)
  return updateSettings({ selectedRuntimes: { [entry.engine]: id } })
}

/** Сборка для запуска: выбранная пользователем (если установлена и совместима), иначе лучшая установленная. */
export async function resolveRuntime(engine: EngineId): Promise<ResolvedRuntime | null> {
  return runtimeStore().resolve(engine, await getHardwareInfo(), getSettings().selectedRuntimes[engine])
}

export function registerRuntimesIpc(): void {
  handle('runtimes:list', () => listRuntimes())
  handle('runtimes:install', (id) => installRuntime(id))
  handle('runtimes:remove', (id) => removeRuntime(id))
  handle('runtimes:select', (id) => selectRuntime(id))
}

export function shutdownRuntimes(): void {
  for (const ac of controllers.values()) ac.abort()
}
