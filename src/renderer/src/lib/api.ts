import type { EventChannel, InvokeChannel, IpcEventMap, IpcInvokeMap } from '@shared/ipc'

/** Вызов main-процесса. Ошибка приходит с чистым текстом (без префикса Electron). */
export async function call<K extends InvokeChannel>(
  channel: K,
  ...args: Parameters<IpcInvokeMap[K]>
): Promise<Awaited<ReturnType<IpcInvokeMap[K]>>> {
  try {
    return await window.nys.invoke(channel, ...args)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    throw new Error(msg.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''), { cause: e })
  }
}

export function subscribe<K extends EventChannel>(channel: K, cb: (p: IpcEventMap[K]) => void): () => void {
  return window.nys.on(channel, cb)
}
