import type { FitLevel } from '@shared/types'
import { FIT_CLASS, FIT_LABEL } from '@/lib/memory'
import { cn } from '@/lib/format'

export function FitBadge({ fit, note }: { fit: FitLevel; note?: string }): React.JSX.Element {
  return (
    <span
      title={note}
      className={cn('inline-flex h-5 items-center rounded px-1.5 text-[11.5px] font-medium whitespace-nowrap', FIT_CLASS[fit])}
    >
      {FIT_LABEL[fit]}
    </span>
  )
}
