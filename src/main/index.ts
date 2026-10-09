import { app, BrowserWindow, dialog, shell } from 'electron'
import { join } from 'node:path'
import { handle } from './ipc'
import { getSettings, loadSettings, setHfToken, setPerModelLoad, updateSettings } from './settings'
import { localDataDir, logsDir, runtimesDir, userDataDir } from './paths'
import { registerModules, shutdownModules } from './modules'
import { buildDiagnostics } from './diagnostics'

app.setName('NeuroYouStudio')
app.setAppUserModelId('com.matyankass.neuroyoustudio')

if (!app.requestSingleInstanceLock()) {
  app.quit()
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
    icon: join(__dirname, '../../build/icon.png'),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
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
    if (!url.startsWith('http://localhost') && !url.startsWith('file://')) {
      e.preventDefault()
      if (/^https?:\/\//.test(url)) void shell.openExternal(url)
    }
  })

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
    await shell.openPath(p)
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
  handle('settings:update', (patch) => updateSettings(patch))
  handle('settings:setPerModelLoad', (id, load) => setPerModelLoad(id, load))
  handle('settings:setHfToken', (token) => setHfToken(token))
}

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  }
})

void app.whenReady().then(async () => {
  localDataDir()
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
  if (quitting) return
  quitting = true
  e.preventDefault()
  void shutdownModules().finally(() => app.quit())
})

app.on('window-all-closed', () => {
  app.quit()
})
