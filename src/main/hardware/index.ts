// ВЛАДЕЛЕЦ: агент «железо + движки». Заглушка с зафиксированной сигнатурой.
import type { HardwareInfo } from '@shared/types'

export async function getHardwareInfo(_refresh = false): Promise<HardwareInfo> {
  return { gpus: [], ramTotalMiB: 0, ramFreeMiB: 0, cpuName: '', cpuCores: 0, cpuThreads: 0, avx2: true, avx512: false }
}

/** Регистрирует IPC hardware:get и запускает живой опрос (событие hardware:live). */
export function registerHardwareIpc(): void {}
