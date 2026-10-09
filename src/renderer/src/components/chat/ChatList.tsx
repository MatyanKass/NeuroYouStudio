import { Copy, Pencil, Plus, Search, Trash2 } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useChat } from '@/store/chat'
import { cn, formatRelative } from '@/lib/format'
import { IconButton } from '@/components/ui/Button'

export function ChatList(): React.JSX.Element {
  const { list, currentId, open, create, remove, rename, duplicate } = useChat()
  const [query, setQuery] = useState('')
  const [editing, setEditing] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [confirmId, setConfirmId] = useState<string | null>(null)

  const items = useMemo(() => {
    const q = query.trim().toLowerCase()
    const filtered = q ? list.filter((c) => c.title.toLowerCase().includes(q)) : list
    return [...filtered].sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || b.updatedAt - a.updatedAt)
  }, [list, query])

  return (
    <aside className="flex w-[248px] shrink-0 flex-col border-r border-line bg-panel">
      <div className="flex items-center gap-2 px-3 pt-3 pb-2">
        <button
          onClick={() => void create()}
          className="flex h-8 flex-1 items-center gap-2 rounded-[var(--radius-ctl)] border border-line-strong/70 px-2.5 text-[13px] text-fg hover:bg-panel-2"
        >
          <Plus size={15} /> Новый чат
        </button>
      </div>
      <div className="px-3 pb-2">
        <div className="flex h-7 items-center gap-1.5 rounded-[var(--radius-ctl)] bg-bg px-2 text-fg-faint focus-within:ring-1 focus-within:ring-accent">
          <Search size={13} />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Поиск по чатам"
            className="w-full bg-transparent text-[12.5px] text-fg outline-none placeholder:text-fg-faint"
          />
        </div>
      </div>
      <div className="flex-1 overflow-y-auto px-1.5 pb-3">
        {items.length === 0 && (
          <p className="px-3 py-6 text-[12.5px] text-fg-faint">
            {query ? 'Ничего не найдено' : 'Здесь появятся ваши диалоги'}
          </p>
        )}
        {items.map((c) => (
          <div
            key={c.id}
            className={cn(
              'group relative flex cursor-pointer flex-col rounded-[var(--radius-ctl)] px-2.5 py-1.5',
              c.id === currentId ? 'bg-raised' : 'hover:bg-panel-2'
            )}
            onClick={() => editing !== c.id && void open(c.id)}
          >
            {editing === c.id ? (
              <input
                autoFocus
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onBlur={() => {
                  void rename(c.id, draft)
                  setEditing(null)
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                  if (e.key === 'Escape') setEditing(null)
                }}
                className="rounded bg-bg px-1 text-[13px] text-fg outline-none ring-1 ring-accent"
              />
            ) : (
              <span className={cn('truncate pr-14 text-[13px]', c.id === currentId ? 'text-fg' : 'text-fg-muted')}>
                {c.title}
              </span>
            )}
            <span className="text-[11.5px] text-fg-faint">{formatRelative(c.updatedAt)}</span>
            {editing !== c.id && (
              <div
                className={cn(
                  'absolute top-1.5 right-1 hidden items-center group-hover:flex',
                  confirmId === c.id && 'flex'
                )}
                onClick={(e) => e.stopPropagation()}
              >
                {confirmId === c.id ? (
                  <button
                    onClick={() => {
                      setConfirmId(null)
                      void remove(c.id)
                    }}
                    onMouseLeave={() => setConfirmId(null)}
                    className="rounded bg-danger/20 px-1.5 py-0.5 text-[11.5px] text-danger"
                  >
                    Удалить?
                  </button>
                ) : (
                  <>
                    <IconButton
                      label="Переименовать"
                      className="h-6 w-6"
                      onClick={() => {
                        setDraft(c.title)
                        setEditing(c.id)
                      }}
                    >
                      <Pencil size={13} />
                    </IconButton>
                    <IconButton label="Дублировать" className="h-6 w-6" onClick={() => void duplicate(c.id)}>
                      <Copy size={13} />
                    </IconButton>
                    <IconButton label="Удалить" className="h-6 w-6" onClick={() => setConfirmId(c.id)}>
                      <Trash2 size={13} />
                    </IconButton>
                  </>
                )}
              </div>
            )}
          </div>
        ))}
      </div>
    </aside>
  )
}
