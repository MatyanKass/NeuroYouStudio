// Подписи и пояснения для настроек, общие для нескольких страниц.
import type { EngineId, MemoryProfileId } from '@shared/config'
import type { Guardrails } from '@shared/types'

export const ENGINE_LABEL: Record<EngineId, string> = {
  llamacpp: 'llama.cpp',
  ikllama: 'ik_llama.cpp',
  exl3: 'ExLlamaV3'
}

export const MEMORY_PROFILES: Array<{ value: MemoryProfileId; label: string; description: string }> = [
  {
    value: 'speed',
    label: 'Макс. скорость',
    description: 'Всё, что помещается, держится в VRAM. В RAM уходит только то, что не влезло.'
  },
  {
    value: 'userSplit',
    label: 'VRAM: Flash Attention + модель / RAM: контекст',
    description:
      'Веса модели и буферы Flash Attention — в видеокарте, контекст (KV-кэш) — в оперативной памяти. Освобождает VRAM под модель крупнее, но длинный контекст считается медленнее.'
  },
  {
    value: 'longContext',
    label: 'Длинный контекст',
    description: 'Контекст остаётся в VRAM, а часть слоёв модели при нехватке места уходит в RAM.'
  },
  {
    value: 'saveVram',
    label: 'Экономия VRAM',
    description: 'Занимает как можно меньше видеопамяти — когда рядом работают игры или другие программы на GPU.'
  }
]

export const GUARDRAILS: Array<{ value: Guardrails; label: string; description: string }> = [
  {
    value: 'off',
    label: 'Выкл (не рекомендуется)',
    description: 'Модель загружается в любом случае. Если памяти не хватит, система может надолго зависнуть.'
  },
  {
    value: 'relaxed',
    label: 'Мягкая',
    description: 'Загрузка блокируется, только если модель явно не помещается в VRAM и RAM вместе.'
  },
  {
    value: 'balanced',
    label: 'Сбалансированная',
    description: 'Оставляет запас памяти для системы и других программ. Подходит в большинстве случаев.'
  },
  {
    value: 'strict',
    label: 'Строгая',
    description: 'Большой запас памяти: загрузка блокируется при малейшем риске нехватки.'
  }
]
