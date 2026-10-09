import type { MemoryComponentId } from '@shared/types'
import { MEM_COLOR, MEM_SHORT } from '@/lib/memory'
import { cn, formatBytes } from '@/lib/format'

export interface BarSegment {
  id: MemoryComponentId
  bytes: number
}

/**
 * Шкала одного вида памяти: сегменты компонентов модели, затем «занято другими программами»
 * (штриховка) и свободное место. Если сегменты не влезают — переполнение подсвечивается.
 */
export function MemoryBar({
  label,
  segments,
  capacityBytes,
  otherBytes = 0,
  height = 8,
  showScale = false,
  className
}: {
  label: string
  segments: BarSegment[]
  capacityBytes: number
  otherBytes?: number
  height?: number
  showScale?: boolean
  className?: string
}): React.JSX.Element {
  const ours = segments.reduce((s, x) => s + x.bytes, 0)
  const total = Math.max(capacityBytes, ours + otherBytes, 1)
  const over = ours + otherBytes > capacityBytes && capacityBytes > 0
  const pct = (b: number): string => `${(b / total) * 100}%`
  const tooltip = [
    ...segments.filter((s) => s.bytes > 0).map((s) => `${MEM_SHORT[s.id]}: ${formatBytes(s.bytes)}`),
    otherBytes > 0 ? `Другие программы: ${formatBytes(otherBytes)}` : '',
    `Всего ${label}: ${formatBytes(capacityBytes)}`
  ]
    .filter(Boolean)
    .join('\n')

  return (
    <div className={cn('min-w-0', className)} title={tooltip}>
      <div
        className={cn('relative flex w-full overflow-hidden rounded-[3px] bg-line', over && 'ring-1 ring-danger')}
        style={{ height }}
        role="img"
        aria-label={tooltip}
      >
        {segments
          .filter((s) => s.bytes > 0)
          .map((s) => (
            <div
              key={s.id}
              className="h-full shrink-0 border-r border-bg/70 last:border-r-0"
              style={{ width: pct(s.bytes), background: MEM_COLOR[s.id] }}
            />
          ))}
        {otherBytes > 0 && (
          <div
            className="h-full shrink-0"
            style={{
              width: pct(otherBytes),
              background:
                'repeating-linear-gradient(135deg, var(--color-line-strong) 0 3px, transparent 3px 6px)'
            }}
          />
        )}
        {over && capacityBytes > 0 && (
          <div className="absolute top-0 bottom-0 w-[2px] bg-danger" style={{ left: pct(capacityBytes) }} />
        )}
      </div>
      {showScale && (
        <div className="tabular mt-1 flex justify-between text-[11.5px] text-fg-faint">
          <span>
            <span className="text-fg-muted">{label}</span> {formatBytes(ours)} модель
            {otherBytes > 0 ? `, ${formatBytes(otherBytes)} другие` : ''}
          </span>
          <span className={over ? 'text-danger' : ''}>
            {formatBytes(ours + otherBytes)} из {formatBytes(capacityBytes)}
          </span>
        </div>
      )}
    </div>
  )
}
