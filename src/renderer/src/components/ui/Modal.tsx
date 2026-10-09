import { Dialog } from 'radix-ui'
import { X } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { cn } from '@/lib/format'
import { Button } from './Button'

const WIDTH = {
  sm: 'max-w-[420px]',
  md: 'max-w-[560px]',
  lg: 'max-w-[720px]'
} as const

/**
 * Модальное окно: затемнение, панель, заголовок, прокручиваемое тело и строка действий.
 * Esc и клик по фону закрывают окно (через onOpenChange).
 */
export function Modal({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  footerStart,
  size = 'md',
  bodyClassName
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: ReactNode
  /** Строка под заголовком (связывается с окном как описание). */
  description?: ReactNode
  children?: ReactNode
  /** Кнопки справа внизу. */
  footer?: ReactNode
  /** Действия слева внизу (например, «Сбросить»). */
  footerStart?: ReactNode
  size?: keyof typeof WIDTH
  bodyClassName?: string
}): React.JSX.Element {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/55" />
        <Dialog.Content
          {...(description ? {} : { 'aria-describedby': undefined })}
          className={cn(
            'fixed top-1/2 left-1/2 z-50 flex max-h-[calc(100vh-48px)] w-[calc(100vw-32px)] -translate-x-1/2 -translate-y-1/2 flex-col rounded-[var(--radius-panel)] border border-line-strong bg-panel text-fg outline-none',
            WIDTH[size]
          )}
        >
          <div className="flex items-start gap-3 border-b border-line px-4 py-3">
            <div className="min-w-0 flex-1">
              <Dialog.Title className="text-[15px] leading-snug font-semibold text-fg">{title}</Dialog.Title>
              {description && (
                <Dialog.Description className="mt-0.5 text-[12.5px] break-words text-fg-muted">
                  {description}
                </Dialog.Description>
              )}
            </div>
            <Dialog.Close
              aria-label="Закрыть"
              title="Закрыть"
              className="-mr-1 inline-grid h-7 w-7 shrink-0 place-items-center rounded-[var(--radius-ctl)] text-fg-faint transition-colors hover:bg-panel-2 hover:text-fg"
            >
              <X size={16} />
            </Dialog.Close>
          </div>
          {children !== undefined && (
            <div className={cn('min-h-0 flex-1 overflow-y-auto', bodyClassName ?? 'px-4 py-3')}>{children}</div>
          )}
          {(footer || footerStart) && (
            <div className="flex items-center gap-2 border-t border-line px-4 py-3">
              {footerStart}
              <div className="ml-auto flex items-center gap-2">{footer}</div>
            </div>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

/**
 * Подтверждение действия. Пока onConfirm выполняется, кнопка неактивна;
 * ошибка показывается в окне, окно остаётся открытым.
 */
export function ConfirmModal({
  open,
  onOpenChange,
  title,
  children,
  confirmLabel,
  danger,
  onConfirm
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: ReactNode
  children?: ReactNode
  confirmLabel: string
  danger?: boolean
  onConfirm: () => Promise<void> | void
}): React.JSX.Element {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const close = (v: boolean): void => {
    if (busy) return
    if (!v) setError(null)
    onOpenChange(v)
  }

  const run = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await onConfirm()
      setBusy(false)
      onOpenChange(false)
    } catch (e) {
      setBusy(false)
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <Modal
      open={open}
      onOpenChange={close}
      title={title}
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={() => close(false)} disabled={busy}>
            Отмена
          </Button>
          <Button variant={danger ? 'danger' : 'primary'} onClick={() => void run()} disabled={busy}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="text-[13.5px] leading-relaxed text-fg-muted">{children}</div>
      {error && <div className="mt-3 text-[13px] text-danger">{error}</div>}
    </Modal>
  )
}
