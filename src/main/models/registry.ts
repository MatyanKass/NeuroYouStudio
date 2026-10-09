// ВЛАДЕЛЕЦ: агент «модели + память». Заглушка с зафиксированной сигнатурой.
import type { LocalModel } from '@shared/types'

/** Список локальных моделей (кэш; rescan — пересканировать папку). */
export async function listModels(_rescan = false): Promise<LocalModel[]> {
  return []
}

export function getModel(_id: string): LocalModel | undefined {
  return undefined
}

export async function deleteModel(_id: string): Promise<void> {}

/** Регистрирует IPC: models:list, models:delete. */
export function registerModelsIpc(): void {}
