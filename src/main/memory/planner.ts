// ВЛАДЕЛЕЦ: агент «модели + память». Заглушка с зафиксированной сигнатурой.
import type { EngineId, LoadConfig } from '@shared/config'
import type { HardwareInfo, LocalModel, MemoryPlan } from '@shared/types'

/**
 * Чистая функция: раскладка памяти для модели при данных настройках и железе.
 * В режиме auto вычисляет resolved-раскладку по профилю; в manual — проверяет и считает как есть.
 * Поле args заполняет слой движков (engines/), здесь оно пустое.
 */
export function planMemory(
  model: LocalModel,
  load: LoadConfig,
  _hw: HardwareInfo,
  engine: EngineId
): MemoryPlan {
  return {
    engine,
    components: [],
    vramBytes: 0,
    ramBytes: model.sizeBytes,
    vramAvailableBytes: 0,
    ramAvailableBytes: 0,
    fit: 'ram',
    resolved: load.memory,
    nLayers: model.arch?.nLayers ?? 0,
    warnings: [],
    args: []
  }
}
