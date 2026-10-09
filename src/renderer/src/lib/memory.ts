import type { FitLevel, MemoryComponentId } from '@shared/types'

export const MEM_COLOR: Record<MemoryComponentId, string> = {
  compute: 'var(--color-mem-compute)',
  attn: 'var(--color-mem-attn)',
  ffn: 'var(--color-mem-ffn)',
  experts: 'var(--color-mem-experts)',
  output: 'var(--color-mem-output)',
  embd: 'var(--color-mem-embd)',
  kv: 'var(--color-mem-kv)',
  mmproj: 'var(--color-mem-mmproj)',
  other: 'var(--color-mem-other)'
}

/** Короткие подписи для легенды карты памяти. */
export const MEM_SHORT: Record<MemoryComponentId, string> = {
  compute: 'Flash Attention',
  attn: 'Attention',
  ffn: 'FFN',
  experts: 'Эксперты',
  output: 'Выход',
  embd: 'Эмбеддинги',
  kv: 'Контекст',
  mmproj: 'Vision',
  other: 'CUDA'
}

export const FIT_LABEL: Record<FitLevel, string> = {
  full: 'Полностью в VRAM',
  partial: 'Частично в RAM',
  ram: 'Только RAM',
  none: 'Не поместится'
}

export const FIT_CLASS: Record<FitLevel, string> = {
  full: 'bg-ok/15 text-ok',
  partial: 'bg-warn/15 text-warn',
  ram: 'bg-info/15 text-info',
  none: 'bg-danger/15 text-danger'
}
