// Модуль «железо»: кэш HardwareInfo, IPC hardware:get, живой опрос → hardware:live.
import type { HardwareInfo } from '@shared/types'
import { handle, emit } from '../ipc'
import { detectHardware, queryGpus, ramInfo, type CpuStatic } from './detect'
import { LivePoller } from './live'

let cached: HardwareInfo | null = null
let pending: Promise<HardwareInfo> | null = null
let cpuCache: CpuStatic | undefined
let poller: LivePoller | null = null

/**
 * Сведения о железе. Первый вызов делает полный опрос (CPU-флаги — один раз);
 * refresh=true перечитывает только память (VRAM/RAM).
 */
export async function getHardwareInfo(refresh = false): Promise<HardwareInfo> {
  if (cached && !refresh) return cached
  if (cached && refresh) {
    // Сбой nvidia-smi при обновлении не должен «терять» видеокарту — оставляем прежние данные.
    const gpus = cached.gpus.length ? await queryGpus() : []
    cached = { ...cached, ...ramInfo(), gpus: gpus.length ? gpus : cached.gpus }
    return cached
  }
  pending ??= detectHardware(cpuCache, undefined)
    .then((hw) => {
      cpuCache = { cpuName: hw.cpuName, cpuCores: hw.cpuCores, cpuThreads: hw.cpuThreads, avx2: hw.avx2, avx512: hw.avx512 }
      cached = hw
      return hw
    })
    .finally(() => {
      pending = null
    })
  return pending
}

/** Регистрирует IPC hardware:get и запускает живой опрос (событие hardware:live). */
export function registerHardwareIpc(): void {
  handle('hardware:get', () => getHardwareInfo())
  void getHardwareInfo().then((hw) => {
    if (poller) return
    poller = new LivePoller(hw.gpus.length, (s) => emit('hardware:live', s))
    poller.start()
  })
}

/** Останавливает опрос nvidia-smi (вызывается из shutdownEngines). */
export function shutdownHardware(): void {
  poller?.stop()
  poller = null
}
