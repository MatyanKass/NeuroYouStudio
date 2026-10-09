// Грубая консервативная оценка «влезет ли модель» по размеру весов. Позже может быть заменена планировщиком по заголовкам.
import type { ModelFormat } from '@shared/config'
import type { FitLevel, HardwareInfo } from '@shared/types'

const MiB = 1024 * 1024
const GiB = 1024 * MiB

export const VRAM_RESERVE_MIB = 768
export const CUDA_OVERHEAD_MIB = 400
export const MIN_CONTEXT_MIB = 512
export const RAM_USABLE_SHARE = 0.8

export interface FitEstimate {
  fit: FitLevel
  note: string
  neededBytes: number
}

/** Веса ×1.05 + контекст 8k (≈6% весов, не меньше 512 МиБ) + 400 МиБ на CUDA. */
export function estimateNeededBytes(sizeBytes: number): number {
  return sizeBytes * 1.05 + Math.max(sizeBytes * 0.06, MIN_CONTEXT_MIB * MiB) + CUDA_OVERHEAD_MIB * MiB
}

export function formatSize(bytes: number): string {
  if (bytes >= GiB) return `${(bytes / GiB).toFixed(1).replace('.', ',')} ГБ`
  return `${Math.max(1, Math.round(bytes / MiB))} МБ`
}

/** Есть ли в hw хоть какие-то данные (иначе оценку не показываем). */
export function hardwareKnown(hw: HardwareInfo | null | undefined): hw is HardwareInfo {
  return Boolean(hw && (hw.gpus.length > 0 || hw.ramTotalMiB > 0))
}

export function estimateFit(sizeBytes: number, format: ModelFormat, hw: HardwareInfo): FitEstimate {
  const needed = estimateNeededBytes(sizeBytes)
  const vram = hw.gpus.reduce((s, g) => s + Math.max(0, g.vramTotalMiB - VRAM_RESERVE_MIB), 0) * MiB
  const ram = Math.max(0, hw.ramTotalMiB) * MiB * RAM_USABLE_SHARE
  const need = formatSize(needed)

  if (hw.gpus.length > 0) {
    if (needed <= vram) return { fit: 'full', note: `Полностью в VRAM (≈${need} из ${formatSize(vram)})`, neededBytes: needed }
    if (format === 'exl3') {
      return {
        fit: 'none',
        note: `Слишком большая для VRAM: нужно ≈${need}, доступно ${formatSize(vram)} (ExLlamaV3 не выгружает веса в RAM)`,
        neededBytes: needed
      }
    }
    if (needed <= vram + ram) {
      return {
        fit: 'partial',
        note: `Частично в RAM: ≈${formatSize(vram)} в VRAM, ≈${formatSize(needed - vram)} в RAM — медленнее`,
        neededBytes: needed
      }
    }
    return { fit: 'none', note: `Слишком большая: нужно ≈${need}, доступно ${formatSize(vram + ram)}`, neededBytes: needed }
  }

  if (format === 'exl3') return { fit: 'none', note: 'ExLlamaV3 требует видеокарту NVIDIA', neededBytes: needed }
  if (needed <= ram) return { fit: 'ram', note: `Без видеокарты: целиком в RAM (≈${need}) — медленно`, neededBytes: needed }
  return { fit: 'none', note: `Слишком большая: нужно ≈${need}, доступно ${formatSize(ram)} RAM`, neededBytes: needed }
}
