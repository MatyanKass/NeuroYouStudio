import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react'
import { cn } from '@/lib/format'

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger'

interface Props extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant
  size?: 'sm' | 'md'
  icon?: ReactNode
}

const VARIANTS: Record<Variant, string> = {
  primary: 'bg-accent text-accent-ink hover:bg-accent-hover font-medium',
  secondary: 'bg-raised text-fg hover:bg-line-strong border border-line-strong/60',
  ghost: 'text-fg-muted hover:text-fg hover:bg-panel-2',
  danger: 'bg-danger/15 text-danger hover:bg-danger/25'
}

export const Button = forwardRef<HTMLButtonElement, Props>(function Button(
  { variant = 'secondary', size = 'md', icon, className, children, ...rest },
  ref
) {
  return (
    <button
      ref={ref}
      className={cn(
        'inline-flex shrink-0 items-center justify-center gap-1.5 rounded-[var(--radius-ctl)] whitespace-nowrap transition-colors disabled:pointer-events-none disabled:opacity-45',
        size === 'sm' ? 'h-7 px-2.5 text-[12.5px]' : 'h-[34px] px-3.5 text-[13.5px]',
        VARIANTS[variant],
        className
      )}
      {...rest}
    >
      {icon}
      {children}
    </button>
  )
})

export function IconButton({
  label,
  className,
  active,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { label: string; active?: boolean }): React.JSX.Element {
  return (
    <button
      title={label}
      aria-label={label}
      className={cn(
        'inline-grid h-7 w-7 shrink-0 place-items-center rounded-[var(--radius-ctl)] transition-colors disabled:opacity-40',
        active ? 'bg-accent-soft text-accent-strong' : 'text-fg-faint hover:bg-panel-2 hover:text-fg',
        className
      )}
      {...rest}
    />
  )
}
