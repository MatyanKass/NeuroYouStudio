import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron'
import type { NysApi } from '@shared/ipc'

const api: NysApi = {
  invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args),
  on: (channel, cb) => {
    const listener = (_e: IpcRendererEvent, payload: unknown): void => cb(payload as never)
    ipcRenderer.on(channel, listener)
    return () => ipcRenderer.removeListener(channel, listener)
  },
  pathForFile: (file) => webUtils.getPathForFile(file)
}

contextBridge.exposeInMainWorld('nys', api)
