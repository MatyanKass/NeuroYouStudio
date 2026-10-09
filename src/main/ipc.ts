import { BrowserWindow, ipcMain } from 'electron'
import type { EventChannel, InvokeChannel, IpcEventMap, IpcInvokeMap } from '@shared/ipc'

type Handler<K extends InvokeChannel> = (
  ...args: Parameters<IpcInvokeMap[K]>
) => ReturnType<IpcInvokeMap[K]> | Promise<Awaited<ReturnType<IpcInvokeMap[K]>>>

export function handle<K extends InvokeChannel>(channel: K, fn: Handler<K>): void {
  ipcMain.handle(channel, (_e, ...args) => fn(...(args as Parameters<IpcInvokeMap[K]>)))
}

export function emit<K extends EventChannel>(channel: K, payload: IpcEventMap[K]): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send(channel, payload)
  }
}
