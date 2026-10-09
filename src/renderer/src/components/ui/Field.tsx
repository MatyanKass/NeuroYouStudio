import { CircleHelp } from 'lucide-react'
import { useId, useState, type ReactNode } from 'react'
import type { Toggle } from '@shared/config'
import { cn } from '@/lib/format'

export function Hint({ text }: { text: string }): React.JSX.Element {
  return (
    <span title={text} className="inline-grid cursor-help text-fg-faint hover:text-fg-muted" aria-label={text}>
      <CircleHelp size={13} />
    </span>
  )
}

export function Switch({
  checked,
  onChange,
  disabled,
  label
}: {
  checked: boolean
  onChange: (v: boolean) => void
  disabled?: boolean
  label?: string
}): React.JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        'relative h-[18px] w-8 shrink-0 rounded-full transition-colors disabled:opacity-40',
        checked ? 'bg-accent' : 'bg-line-strong'
      )}
    >
      <span
        className={cn(
          'absolute top-[2px] left-0 h-[14px] w-[14px] rounded-full bg-white transition-transform',
          checked ? 'translate-x-[16px]' : 'translate-x-[2px]'
        )}
      />
    </button>
  )
}

/** Строка настройки: подпись слева, управление справа (или под подписью при stacked). */
export function Field({
  label,
  hint,
  children,
  stacked,
  disabled,
  badge
}: {
  label: ReactNode
  hint?: string
  children: ReactNode
  stacked?: boolean
  disabled?: boolean
  badge?: ReactNode
}): React.JSX.Element {
  return (
    <div
      className={cn(
        'py-1.5',
        stacked ? 'flex flex-col gap-1.5' : 'flex items-center justify-between gap-3',
        disabled && 'pointer-events-none opacity-50'
      )}
    >
      <div className="flex min-w-0 items-center gap-1.5 text-[13px] text-fg-muted">
        <span className="truncate">{label}</span>
        {hint && <Hint text={hint} />}
        {badge}
      </div>
      {children}
    </div>
  )
}

export function NumberInput({
  value,
  onChange,
  min,
  max,
  step = 1,
  disabled,
  className,
  width = 'w-20'
}: {
  value: number
  onChange: (v: number) => void
  min?: number
  max?: number
  step?: number
  disabled?: boolean
  className?: string
  width?: string
}): React.JSX.Element {
  const [draft, setDraft] = useState<string | null>(null)
  const commit = (raw: string): void => {
    setDraft(null)
    let v = Number(raw.replace(',', '.'))
    if (!Number.isFinite(v)) return
    if (min !== undefined) v = Math.max(min, v)
    if (max !== undefined) v = Math.min(max, v)
    onChange(v)
  }
  return (
    <input
      type="text"
      inputMode="decimal"
      disabled={disabled}
      value={draft ?? String(value)}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={(e) => commit(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit((e.target as HTMLInputElement).value)
        if (e.key === 'Escape') setDraft(null)
        if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
          e.preventDefault()
          const d = (e.key === 'ArrowUp' ? 1 : -1) * step * (e.shiftKey ? 10 : 1)
          commit(String(Math.round((value + d) * 1e6) / 1e6))
        }
      }}
      className={cn(
        'tabular h-7 rounded-[var(--radius-ctl)] border border-line bg-bg px-2 text-right text-[13px] text-fg outline-none focus:border-accent disabled:opacity-40',
        width,
        className
      )}
    />
  )
}

export function Slider({
  value,
  onChange,
  min,
  max,
  step = 1,
  disabled,
  label
}: {
  value: number
  onChange: (v: number) => void
  min: number
  max: number
  step?: number
  disabled?: boolean
  label?: string
}): React.JSX.Element {
  const fill = max > min ? ((value - min) / (max - min)) * 100 : 0
  return (
    <input
      type="range"
      aria-label={label}
      className="nys-range w-full"
      style={{ ['--fill' as string]: `${Math.max(0, Math.min(100, fill))}%` }}
      min={min}
      max={max}
      step={step}
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(Number(e.target.value))}
    />
  )
}

/** Слайдер + число, как в LM Studio. */
export function SliderField({
  label,
  hint,
  value,
  onChange,
  min,
  max,
  step = 1,
  disabled,
  inputMax,
  suffix
}: {
  label: ReactNode
  hint?: string
  value: number
  onChange: (v: number) => void
  min: number
  max: number
  step?: number
  disabled?: boolean
  inputMax?: number
  suffix?: ReactNode
}): React.JSX.Element {
  return (
    <div className={cn('py-1.5', disabled && 'opacity-50')}>
      <div className="mb-1 flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 text-[13px] text-fg-muted">
          <span>{label}</span>
          {hint && <Hint text={hint} />}
        </div>
        <div className="flex items-center gap-1.5">
          {suffix}
          <NumberInput
            value={value}
            onChange={onChange}
            min={min}
            max={inputMax ?? max}
            step={step}
            disabled={disabled}
          />
        </div>
      </div>
      <Slider
        value={Math.min(value, max)}
        onChange={onChange}
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        label={typeof label === 'string' ? label : undefined}
      />
    </div>
  )
}

/** Число с галочкой «включено» (Toggle<number> из настроек LM Studio). */
export function ToggleNumberField({
  label,
  hint,
  value,
  onChange,
  min,
  max,
  step = 1,
  slider,
  offLabel
}: {
  label: ReactNode
  hint?: string
  value: Toggle<number>
  onChange: (v: Toggle<number>) => void
  min?: number
  max?: number
  step?: number
  slider?: boolean
  offLabel?: string
}): React.JSX.Element {
  const id = useId()
  return (
    <div className="py-1.5">
      <div className="flex items-center justify-between gap-2">
        <label htmlFor={id} className="flex cursor-pointer items-center gap-2 text-[13px] text-fg-muted">
          <input
            id={id}
            type="checkbox"
            className="h-3.5 w-3.5 accent-[var(--color-accent)]"
            checked={value.enabled}
            onChange={(e) => onChange({ ...value, enabled: e.target.checked })}
          />
          <span>{label}</span>
          {hint && <Hint text={hint} />}
        </label>
        {value.enabled || !offLabel ? (
          <NumberInput
            value={value.value}
            onChange={(v) => onChange({ ...value, value: v })}
            min={min}
            max={max}
            step={step}
            disabled={!value.enabled}
          />
        ) : (
          <span className="text-[12.5px] text-fg-faint">{offLabel}</span>
        )}
      </div>
      {slider && value.enabled && min !== undefined && max !== undefined && (
        <Slider value={value.value} onChange={(v) => onChange({ ...value, value: v })} min={min} max={max} step={step} />
      )}
    </div>
  )
}

export function Select<T extends string>({
  value,
  onChange,
  options,
  disabled,
  className,
  label
}: {
  value: T
  onChange: (v: T) => void
  options: Array<{ value: T; label: string; disabled?: boolean }>
  disabled?: boolean
  className?: string
  label?: string
}): React.JSX.Element {
  return (
    <select
      value={value}
      disabled={disabled}
      aria-label={label}
      onChange={(e) => onChange(e.target.value as T)}
      className={cn(
        'h-7 max-w-[62%] rounded-[var(--radius-ctl)] border border-line bg-bg px-1.5 text-[13px] text-fg outline-none focus:border-accent disabled:opacity-40',
        className
      )}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value} disabled={o.disabled}>
          {o.label}
        </option>
      ))}
    </select>
  )
}

export function TextArea({
  value,
  onChange,
  placeholder,
  rows = 4,
  mono,
  className
}: {
  value: string
  onChange: (v: string) => void
  placeholder?: string
  rows?: number
  mono?: boolean
  className?: string
}): React.JSX.Element {
  return (
    <textarea
      value={value}
      rows={rows}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      className={cn(
        'w-full resize-y rounded-[var(--radius-ctl)] border border-line bg-bg px-2.5 py-2 text-[13px] text-fg outline-none placeholder:text-fg-faint focus:border-accent',
        mono && 'font-mono text-[12px]',
        className
      )}
    />
  )
}

export function TextInput({
  value,
  onChange,
  placeholder,
  className,
  type = 'text',
  onEnter
}: {
  value: string
  onChange: (v: string) => void
  placeholder?: string
  className?: string
  type?: string
  onEnter?: () => void
}): React.JSX.Element {
  return (
    <input
      type={type}
      value={value}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') onEnter?.()
      }}
      className={cn(
        'h-[34px] w-full rounded-[var(--radius-ctl)] border border-line bg-bg px-2.5 text-[13.5px] text-fg outline-none placeholder:text-fg-faint focus:border-accent',
        className
      )}
    />
  )
}

export function Section({
  title,
  children,
  defaultOpen = true,
  right
}: {
  title: string
  children: ReactNode
  defaultOpen?: boolean
  right?: ReactNode
}): React.JSX.Element {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <section className="border-b border-line px-4 py-2">
      <div className="flex items-center justify-between">
        <button
          type="button"
          onClick={() => setOpen(!open)}
          className="flex items-center gap-1.5 py-1 text-[13px] font-semibold text-fg"
          aria-expanded={open}
        >
          <span className={cn('inline-block w-2 text-fg-faint transition-transform', open ? 'rotate-90' : '')}>›</span>
          {title}
        </button>
        {right}
      </div>
      {open && <div className="pb-1">{children}</div>}
    </section>
  )
}
