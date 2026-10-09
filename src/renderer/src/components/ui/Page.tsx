import { RotateCcw, TriangleAlert } from 'lucide-react'
import type { ReactNode } from 'react'
import { cn } from '@/lib/format'
import { Button } from './Button'

/** Шапка страницы: заголовок слева, действия справа. */
export function PageHeader({ title, children }: { title: string; children?: ReactNode }): React.JSX.Element {
  return (
    <header className="flex h-14 shrink-0 items-center gap-3 border-b border-line px-6">
      <h1 className="shrink-0 text-[16px] font-semibold text-fg">{title}</h1>
      <div className="flex min-w-0 flex-1 items-center justify-end gap-2">{children}</div>
    </header>
  )
}

/** Пустое состояние: что здесь будет и что сделать. */
export function EmptyState({
  icon,
  title,
  children,
  actions,
  className
}: {
  icon?: ReactNode
  title: string
  children?: ReactNode
  actions?: ReactNode
  className?: string
}): React.JSX.Element {
  return (
    <div className={cn('mx-auto flex max-w-[480px] flex-col items-center px-6 py-16 text-center', className)}>
      {icon && <div className="mb-3 text-fg-faint">{icon}</div>}
      <h2 className="text-[15px] font-semibold text-fg">{title}</h2>
      {children && <div className="mt-1.5 text-[13px] leading-relaxed text-fg-muted">{children}</div>}
      {actions && <div className="mt-5 flex flex-wrap justify-center gap-2">{actions}</div>}
    </div>
  )
}

/** Ошибка в потоке страницы, с кнопкой «Повторить». */
export function InlineError({
  message,
  onRetry,
  retryLabel = 'Повторить',
  className
}: {
  message: ReactNode
  onRetry?: () => void
  retryLabel?: string
  className?: string
}): React.JSX.Element {
  return (
    <div
      role="alert"
      className={cn(
        'flex items-start gap-2 rounded-[var(--radius-ctl)] border border-danger/30 bg-danger/8 px-3 py-2 text-[13px] text-danger',
        className
      )}
    >
      <TriangleAlert size={15} className="mt-[2px] shrink-0" />
      <div className="min-w-0 flex-1 break-words">{message}</div>
      {onRetry && (
        <Button size="sm" variant="ghost" className="-my-1 text-danger! hover:bg-danger/10!" onClick={onRetry} icon={<RotateCcw size={13} />}>
          {retryLabel}
        </Button>
      )}
    </div>
  )
}

const TONES = {
  neutral: 'bg-raised text-fg-muted',
  ok: 'bg-ok/15 text-ok',
  warn: 'bg-warn/15 text-warn',
  danger: 'bg-danger/15 text-danger',
  info: 'bg-info/15 text-info',
  accent: 'bg-accent-soft text-accent-strong'
} as const

export type TagTone = keyof typeof TONES

/** Небольшая метка (бейдж). */
export function Tag({
  children,
  tone = 'neutral',
  title,
  className
}: {
  children: ReactNode
  tone?: TagTone
  title?: string
  className?: string
}): React.JSX.Element {
  return (
    <span
      title={title}
      className={cn(
        'inline-flex h-5 shrink-0 items-center gap-1 rounded px-1.5 text-[11.5px] font-medium whitespace-nowrap',
        TONES[tone],
        className
      )}
    >
      {children}
    </span>
  )
}

/** Полоса прогресса. value 0…1; null — неопределённый прогресс. */
export function ProgressBar({
  value,
  tone = 'accent',
  className,
  label
}: {
  value: number | null
  tone?: 'accent' | 'danger' | 'muted' | 'ok'
  className?: string
  label?: string
}): React.JSX.Element {
  const fill =
    tone === 'danger' ? 'bg-danger' : tone === 'muted' ? 'bg-fg-faint' : tone === 'ok' ? 'bg-ok' : 'bg-accent'
  const pct = value === null ? null : Math.max(0, Math.min(1, value)) * 100
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct === null ? undefined : Math.round(pct)}
      className={cn('h-1.5 w-full overflow-hidden rounded-full bg-line', className)}
    >
      {pct === null ? (
        <div className={cn('h-full w-full animate-pulse opacity-50', fill)} />
      ) : (
        <div className={cn('h-full rounded-full transition-[width] duration-300', fill)} style={{ width: `${pct}%` }} />
      )}
    </div>
  )
}
