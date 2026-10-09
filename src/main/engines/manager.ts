// ВЛАДЕЛЕЦ: агент «железо + движки». Заглушка с зафиксированной сигнатурой.
import type { EngineId } from '@shared/config'
import type { EngineStatus } from '@shared/types'

export interface ActiveEngine {
  engine: EngineId
  /** http://127.0.0.1:PORT */
  baseUrl: string
  modelId: string
  contextLength: number
  vision: boolean
}

/** Текущий загруженный движок (для чата), или null. */
export function activeEngine(): ActiveEngine | null {
  return null
}

export function engineStatus(): EngineStatus {
  return { state: 'idle' }
}

/** Регистрирует IPC engine:*, memory:plan, runtimes:*. */
export function registerEngineIpc(): void {}

export async function shutdownEngines(): Promise<void> {}
