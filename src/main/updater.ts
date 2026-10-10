import { app, shell } from 'electron'
import type { UpdateStatus } from '@shared/types'
import { handle } from './ipc'
import { emit } from './ipc'

// Автообновление через GitHub Releases (electron-updater для установленной версии;
// portable сама себя не заменяет — там открываем страницу релизов).

const REPO = 'MatyanKass/NeuroYouStudio'
const RELEASES_URL = `https://github.com/${REPO}/releases/latest`

const isPortable = (): boolean => Boolean(process.env.PORTABLE_EXECUTABLE_FILE)

let status: UpdateStatus = { state: 'idle', currentVersion: app.getVersion() }

function set(patch: Partial<UpdateStatus>): void {
  status = { ...status, ...patch }
  emit('update:status', status)
}

/** Сравнение версий вида 1.2.3 (без суффиксов). >0 если a новее b. */
function cmpVersion(a: string, b: string): number {
  const pa = a.split('.').map((x) => parseInt(x, 10) || 0)
  const pb = b.split('.').map((x) => parseInt(x, 10) || 0)
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return d > 0 ? 1 : -1
  }
  return 0
}

/** Проверка последнего релиза напрямую через GitHub API (для portable и как запасной путь). */
async function checkViaApi(): Promise<UpdateStatus> {
  const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'NeuroYouStudio' },
    signal: AbortSignal.timeout(15000)
  })
  if (!res.ok) throw new Error(`GitHub ответил ${res.status}`)
  const j = (await res.json()) as { tag_name?: string; name?: string; body?: string }
  const tag = (j.tag_name ?? '').replace(/^v/, '')
  const cur = app.getVersion()
  if (!tag || cmpVersion(tag, cur) <= 0) {
    return { state: 'notAvailable', currentVersion: cur }
  }
  return { state: 'available', currentVersion: cur, newVersion: tag, notes: j.body, manual: true }
}

// electron-updater грузится лениво: в dev и portable он не нужен и не должен падать на старте.
async function autoUpdater(): Promise<import('electron-updater').AppUpdater> {
  const mod = await import('electron-updater')
  const u = mod.autoUpdater
  u.autoDownload = false
  u.autoInstallOnAppQuit = true
  u.removeAllListeners()
  u.on('download-progress', (p) => set({ state: 'downloading', percent: Math.round(p.percent) }))
  u.on('update-downloaded', (info) => set({ state: 'downloaded', newVersion: info.version }))
  u.on('error', (e) => set({ state: 'error', error: e instanceof Error ? e.message : String(e) }))
  return u
}

export async function checkForUpdates(): Promise<UpdateStatus> {
  if (!app.isPackaged) {
    set({ state: 'unsupported', error: 'Обновление доступно только в установленной версии.' })
    return status
  }
  set({ state: 'checking', error: undefined, percent: undefined })
  try {
    if (isPortable()) {
      set(await checkViaApi())
      return status
    }
    const u = await autoUpdater()
    const r = await u.checkForUpdates()
    const v = r?.updateInfo.version
    if (v && cmpVersion(v, app.getVersion()) > 0) {
      set({ state: 'available', newVersion: v, notes: r?.updateInfo.releaseNotes as string | undefined })
    } else {
      set({ state: 'notAvailable' })
    }
  } catch (e) {
    // Запасной путь: хотя бы узнать, есть ли новая версия, и предложить ручную загрузку.
    try {
      const api = await checkViaApi()
      set(api.state === 'available' ? { ...api, manual: true } : api)
    } catch {
      set({ state: 'error', error: e instanceof Error ? e.message : String(e) })
    }
  }
  return status
}

export async function downloadUpdate(): Promise<void> {
  if (status.manual || isPortable() || !app.isPackaged) {
    await shell.openExternal(RELEASES_URL)
    return
  }
  set({ state: 'downloading', percent: 0 })
  try {
    const u = await autoUpdater()
    await u.downloadUpdate()
  } catch (e) {
    set({ state: 'error', error: e instanceof Error ? e.message : String(e) })
  }
}

export async function installUpdate(): Promise<void> {
  if (status.manual || isPortable() || !app.isPackaged) {
    await shell.openExternal(RELEASES_URL)
    return
  }
  const u = await autoUpdater()
  // Закрывает приложение и запускает установщик скачанной версии.
  setImmediate(() => u.quitAndInstall())
}

export function registerUpdaterIpc(): void {
  handle('update:check', () => checkForUpdates())
  handle('update:download', () => downloadUpdate())
  handle('update:install', () => installUpdate())
}
