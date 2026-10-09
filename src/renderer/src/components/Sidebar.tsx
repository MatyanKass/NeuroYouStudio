import { Boxes, Cpu, Download, MessageSquare, Search, Settings } from 'lucide-react'
import type { ComponentType } from 'react'
import { useUi, type PageId } from '@/store/ui'
import { cn } from '@/lib/format'

const ITEMS: Array<{ id: PageId; label: string; icon: ComponentType<{ size?: number }> }> = [
  { id: 'chat', label: 'Чат', icon: MessageSquare },
  { id: 'models', label: 'Мои модели', icon: Boxes },
  { id: 'discover', label: 'Поиск', icon: Search },
  { id: 'downloads', label: 'Загрузки', icon: Download },
  { id: 'runtimes', label: 'Движки', icon: Cpu }
]

export function Sidebar(): React.JSX.Element {
  const { page, setPage } = useUi()
  const btn = (id: PageId, label: string, Icon: ComponentType<{ size?: number }>): React.JSX.Element => (
    <button
      key={id}
      title={label}
      onClick={() => setPage(id)}
      className={cn(
        'group flex w-full flex-col items-center gap-1 rounded-lg px-1 py-2 text-[11px] transition-colors',
        page === id ? 'bg-accent-soft text-accent-strong' : 'text-fg-faint hover:bg-panel-2 hover:text-fg'
      )}
    >
      <Icon size={20} />
      <span className="leading-none">{label}</span>
    </button>
  )
  return (
    <nav className="flex w-[76px] shrink-0 flex-col items-stretch gap-1 border-r border-line bg-panel px-2 py-3">
      <div className="mb-3 flex justify-center">
        <div className="grid h-9 w-9 place-items-center rounded-xl bg-accent text-[13px] font-bold text-accent-ink">NY</div>
      </div>
      {ITEMS.map((i) => btn(i.id, i.label, i.icon))}
      <div className="flex-1" />
      {btn('settings', 'Настройки', Settings)}
    </nav>
  )
}
