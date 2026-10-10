import { app, BrowserWindow, dialog, shell } from 'electron'
import { promises as fs } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { handle } from './ipc'
import { getSettings, loadSettings, setHfToken, setPerModelLoad, updateSettings } from './settings'
import { localDataDir, logsDir, runtimesDir, userDataDir } from './paths'
import { registerModules, shutdownModules } from './modules'
import { buildDiagnostics } from './diagnostics'
import { registerUpdaterIpc } from './updater'
import { applySystemProxy } from './util/system-proxy'
import icon from '../../resources/icon.png?asset'

app.setName('NeuroYouStudio')
app.setAppUserModelId('com.matyankass.neuroyoustudio')

const primaryInstance = app.requestSingleInstanceLock()
if (!primaryInstance) app.quit()

/** Сколько ждать остановки движков и загрузок при выходе, прежде чем закрыться принудительно. */
const SHUTDOWN_TIMEOUT_MS = 15_000

/** Куда окну приложения можно переходить: только на свою страницу (dev-сервер или index.html). */
function isAppUrl(url: string): boolean {
  const dev = !app.isPackaged ? process.env['ELECTRON_RENDERER_URL'] : undefined
  try {
    const u = new URL(url)
    if (dev) return u.origin === new URL(dev).origin
    return u.protocol === 'file:' && u.pathname.toLowerCase().endsWith('/renderer/index.html')
  } catch {
    return false
  }
}

let mainWindow: BrowserWindow | null = null

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1000,
    minHeight: 640,
    show: false,
    backgroundColor: '#0f1115',
    title: 'NeuroYouStudio',
    autoHideMenuBar: true,
    icon,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  mainWindow.setMenuBarVisibility(false)
  mainWindow.once('ready-to-show', () => mainWindow?.show())

  // Внешние ссылки — в системный браузер.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  mainWindow.webContents.on('will-navigate', (e, url) => {
    if (isAppUrl(url)) return
    e.preventDefault()
    if (/^https?:\/\//.test(url)) void shell.openExternal(url)
  })
  mainWindow.webContents.on('will-attach-webview', (e) => e.preventDefault())

  if (!app.isPackaged && process.env['ELECTRON_RENDERER_URL']) {
    void mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function registerCoreIpc(): void {
  handle('app:info', () => ({
    version: app.getVersion(),
    userDataDir: userDataDir(),
    runtimesDir: runtimesDir(),
    logsDir: logsDir(),
    isPackaged: app.isPackaged
  }))
  handle('app:openPath', async (p) => {
    // Только показать папку/файл в проводнике: открыть (запустить) произвольный файл нельзя.
    if (typeof p !== 'string' || !isAbsolute(p)) throw new Error('Некорректный путь')
    const st = await fs.stat(p).catch(() => null)
    if (!st) throw new Error(`Папка не найдена: ${p}`)
    if (!st.isDirectory()) {
      shell.showItemInFolder(p)
      return
    }
    const err = await shell.openPath(p)
    if (err) throw new Error(err)
  })
  handle('app:openExternal', async (url) => {
    if (/^https?:\/\//.test(url)) await shell.openExternal(url)
  })
  handle('app:pickFolder', async (title) => {
    const res = await dialog.showOpenDialog({ title, properties: ['openDirectory', 'createDirectory'] })
    return res.canceled ? null : (res.filePaths[0] ?? null)
  })
  handle('app:diagnostics', () => buildDiagnostics())
  handle('settings:get', () => getSettings())
  handle('settings:update', (patch) => {
    if (!patch || typeof patch !== 'object') throw new Error('Некорректные настройки')
    // Наличие токена знает только main (settings:setHfToken).
    const { hasHfToken: _ignored, ...rest } = patch
    void _ignored
    return updateSettings(rest)
  })
  handle('settings:setPerModelLoad', (id, load) => setPerModelLoad(id, load))
  handle('settings:setHfToken', (token) => setHfToken(token))
  registerUpdaterIpc()
}

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  }
})

void app.whenReady().then(async () => {
  if (!primaryInstance) return
  localDataDir()
  await applySystemProxy().catch((e: unknown) => console.error('[proxy] не удалось применить системный прокси:', e))
  await loadSettings()
  registerCoreIpc()
  await registerModules()
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

let quitting = false
app.on('before-quit', (e) => {
  if (quitting || !primaryInstance) return
  quitting = true
  e.preventDefault()
  // Зависший движок не должен держать приложение открытым вечно.
  const timeout = new Promise<void>((res) => setTimeout(res, SHUTDOWN_TIMEOUT_MS).unref())
  void Promise.race([shutdownModules().catch(() => undefined), timeout]).finally(() => app.quit())
})

app.on('window-all-closed', () => {
  app.quit()
})
