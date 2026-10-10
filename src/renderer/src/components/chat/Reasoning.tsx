import { Brain, ChevronDown } from 'lucide-react'
import { useState } from 'react'
import { cn } from '@/lib/format'
import { useSettings } from '@/store/app'

/** Свёрнутые рассуждения модели. */
export function Reasoning({ text, live }: { text: string; live: boolean }): React.JSX.Element {
  const expandDefault = useSettings((s) => s.settings?.expandReasoning ?? false)
  const [open, setOpen] = useState(expandDefault)
  return (
    <div className="mb-2.5">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 text-[12.5px] text-fg-faint hover:text-fg-muted"
        aria-expanded={open}
      >
        <Brain size={14} />
        {live ? 'Модель рассуждает…' : 'Рассуждения'}
        <ChevronDown size={13} className={cn('transition-transform', open && 'rotate-180')} />
      </button>
      {open && (
        <div className="mt-1.5 border-l-2 border-line-strong pl-3 text-[13px] whitespace-pre-wrap text-fg-muted">{text}</div>
      )}
    </div>
  )
}
