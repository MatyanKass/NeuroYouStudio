import { useRef } from 'react'
import { cn } from '@/lib/format'

/** Переключатель из нескольких вариантов (радиогруппа). Стрелки ←/→ меняют выбор. */
export function Segmented<T extends string>({
  value,
  onChange,
  options,
  label,
  className
}: {
  value: T
  onChange: (v: T) => void
  options: Array<{ value: T; label: string; title?: string }>
  label: string
  className?: string
}): React.JSX.Element {
  const refs = useRef<Array<HTMLButtonElement | null>>([])
  const idx = Math.max(
    0,
    options.findIndex((o) => o.value === value)
  )

  const move = (d: number): void => {
    const next = (idx + d + options.length) % options.length
    const o = options[next]
    if (!o) return
    onChange(o.value)
    refs.current[next]?.focus()
  }

  return (
    <div
      role="radiogroup"
      aria-label={label}
      className={cn(
        'inline-flex h-[30px] shrink-0 items-center gap-0.5 rounded-[var(--radius-ctl)] border border-line bg-bg p-0.5',
        className
      )}
      onKeyDown={(e) => {
        if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
          e.preventDefault()
          move(1)
        } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
          e.preventDefault()
          move(-1)
        }
      }}
    >
      {options.map((o, i) => {
        const active = o.value === value
        return (
          <button
            key={o.value}
            ref={(el) => {
              refs.current[i] = el
            }}
            type="button"
            role="radio"
            aria-checked={active}
            tabIndex={active ? 0 : -1}
            title={o.title}
            onClick={() => onChange(o.value)}
            className={cn(
              'h-full rounded-[4px] px-2.5 text-[12.5px] whitespace-nowrap transition-colors',
              active ? 'bg-accent-soft font-medium text-accent-strong' : 'text-fg-muted hover:text-fg'
            )}
          >
            {o.label}
          </button>
        )
      })}
    </div>
  )
}
