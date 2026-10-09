import type { EngineId } from '@shared/config'
import type { RuntimeDescriptor } from '@shared/types'

/**
 * Какая сборка реально запустится для движка: выбранная вручную (если установлена и подходит),
 * иначе лучшая из установленных подходящих (как runtimes/store.resolve в main).
 */
export function effectiveRuntime(
  engine: EngineId,
  runtimes: RuntimeDescriptor[],
  selectedId: string | undefined
): { runtime: RuntimeDescriptor; auto: boolean } | null {
  const usable = runtimes.filter((r) => r.engine === engine && r.installed && r.compatible)
  const chosen = usable.find((r) => r.id === selectedId)
  if (chosen) return { runtime: chosen, auto: false }
  const best = usable.find((r) => r.recommended) ?? usable[0]
  return best ? { runtime: best, auto: true } : null
}
