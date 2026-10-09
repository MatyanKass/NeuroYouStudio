import {
  Brain,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Copy,
  FileText,
  GitBranch,
  Pencil,
  RefreshCw,
  StepForward,
  Trash2
} from 'lucide-react'
import { memo, useEffect, useState } from 'react'
import type { Attachment, ChatMessage, GenerationStats, StopReason } from '@shared/types'
import { call } from '@/lib/api'
import { cn, formatBytes } from '@/lib/format'
import { useChat } from '@/store/chat'
import { useSettings } from '@/store/app'
import { IconButton, Button } from '@/components/ui/Button'
import { Markdown } from './Markdown'

const STOP_LABEL: Record<StopReason, string> = {
  eosFound: 'модель закончила ответ',
  stopStringFound: 'стоп-строка',
  maxPredictedTokensReached: 'достигнут лимит длины ответа',
  contextLengthReached: 'закончился контекст',
  userStopped: 'остановлено',
  modelUnloaded: 'модель выгружена',
  failed: 'ошибка'
}

function Stats({ s }: { s: GenerationStats }): React.JSX.Element {
  const parts: string[] = []
  if (s.tokensPerSecond > 0) parts.push(`${s.tokensPerSecond.toFixed(1)} ток/с`)
  if (s.completionTokens) parts.push(`${s.completionTokens} токенов`)
  if (s.timeToFirstTokenMs) parts.push(`${(s.timeToFirstTokenMs / 1000).toFixed(2)} с до первого токена`)
  if (s.draftTotal) parts.push(`черновик принят на ${Math.round(((s.draftAccepted ?? 0) / s.draftTotal) * 100)}%`)
  return (
    <div
      className="tabular flex flex-wrap gap-x-3 gap-y-0.5 text-[11.5px] text-fg-faint"
      title={s.promptTokens ? `Промпт: ${s.promptTokens} токенов${s.promptTokensPerSecond ? `, ${s.promptTokensPerSecond.toFixed(0)} ток/с` : ''}` : undefined}
    >
      {parts.map((p) => (
        <span key={p}>{p}</span>
      ))}
      <span className={s.stopReason === 'failed' ? 'text-danger' : ''}>{STOP_LABEL[s.stopReason]}</span>
    </div>
  )
}

function ImageThumb({ att }: { att: Attachment }): React.JSX.Element {
  const [src, setSrc] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    call('attachments:preview', att, 480)
      .then((u) => alive && setSrc(u))
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [att])
  return src ? (
    <img src={src} alt={att.name} className="max-h-48 max-w-[280px] rounded-[var(--radius-ctl)] border border-line object-contain" />
  ) : (
    <div className="grid h-24 w-32 place-items-center rounded-[var(--radius-ctl)] border border-line text-[11px] text-fg-faint">
      {att.name}
    </div>
  )
}

export function AttachmentChips({ items, onRemove }: { items: Attachment[]; onRemove?: (id: string) => void }): React.JSX.Element {
  return (
    <div className="flex flex-wrap gap-2">
      {items.map((a) =>
        a.kind === 'image' ? (
          <div key={a.id} className="relative">
            <ImageThumb att={a} />
            {onRemove && (
              <button
                onClick={() => onRemove(a.id)}
                className="absolute top-1 right-1 rounded bg-bg/80 px-1 text-[11px] text-fg hover:text-danger"
                aria-label={`Убрать ${a.name}`}
              >
                ✕
              </button>
            )}
          </div>
        ) : (
          <div
            key={a.id}
            className="flex items-center gap-2 rounded-[var(--radius-ctl)] border border-line bg-panel-2 px-2.5 py-1.5 text-[12.5px]"
          >
            <FileText size={15} className="text-fg-faint" />
            <span className="max-w-[220px] truncate text-fg">{a.name}</span>
            <span className="tabular text-fg-faint">{formatBytes(a.sizeBytes)}</span>
            {a.injection && (
              <span className="text-fg-faint" title={a.injection === 'full' ? 'Документ вставлен в контекст целиком' : 'В контекст подставлены подходящие фрагменты'}>
                {a.injection === 'full' ? 'целиком' : 'фрагменты'}
              </span>
            )}
            {onRemove && (
              <button onClick={() => onRemove(a.id)} className="text-fg-faint hover:text-danger" aria-label={`Убрать ${a.name}`}>
                ✕
              </button>
            )}
          </div>
        )
      )}
    </div>
  )
}

function Reasoning({ text, live }: { text: string; live: boolean }): React.JSX.Element {
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

export const MessageItem = memo(function MessageItem({
  m,
  isLast,
  streaming
}: {
  m: ChatMessage
  isLast: boolean
  streaming: boolean
}): React.JSX.Element {
  const { regenerate, continueMessage, editMessage, deleteMessage, switchVersion, duplicate, currentId } = useChat()
  const v = m.versions[m.activeVersion]
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [copied, setCopied] = useState(false)
  if (!v) return <></>
  const isUser = m.role === 'user'
  const waiting = streaming && !v.content && !v.reasoning

  const startEdit = (): void => {
    setDraft(v.content)
    setEditing(true)
  }
  const copy = (): void => {
    void navigator.clipboard.writeText(v.content)
    setCopied(true)
    setTimeout(() => setCopied(false), 1200)
  }

  return (
    <div className={cn('group flex w-full', isUser ? 'justify-end' : 'justify-start')}>
      <div className={cn('flex min-w-0 flex-col gap-1.5', isUser ? 'max-w-[78%] items-end' : 'w-full')}>
        {m.attachments?.length ? <AttachmentChips items={m.attachments} /> : null}

        {editing ? (
          <div className="flex w-full min-w-[420px] flex-col gap-2">
            <textarea
              autoFocus
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              rows={Math.min(14, Math.max(3, draft.split('\n').length + 1))}
              className="w-full resize-y rounded-[var(--radius-panel)] border border-accent bg-bg px-3 py-2 text-[14px] text-fg outline-none"
            />
            <div className="flex justify-end gap-2">
              <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
                Отмена
              </Button>
              <Button
                size="sm"
                onClick={() => {
                  setEditing(false)
                  void editMessage(m.id, draft, false)
                }}
              >
                Сохранить
              </Button>
              {isUser && (
                <Button
                  size="sm"
                  variant="primary"
                  onClick={() => {
                    setEditing(false)
                    void editMessage(m.id, draft, true)
                  }}
                >
                  Сохранить и отправить
                </Button>
              )}
            </div>
          </div>
        ) : isUser ? (
          <div className="rounded-[14px] rounded-br-[4px] bg-raised px-3.5 py-2 text-[14px] whitespace-pre-wrap text-fg">
            {v.content}
          </div>
        ) : (
          <div className="w-full text-[14.5px] text-fg">
            {v.reasoning ? <Reasoning text={v.reasoning} live={streaming && !v.content} /> : null}
            {waiting ? (
              <div className="flex items-center gap-2 py-1 text-[13px] text-fg-faint">
                <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-accent" />
                Обрабатываю промпт…
              </div>
            ) : (
              <Markdown text={v.content} />
            )}
            {v.error && (
              <div className="mt-2 rounded-[var(--radius-ctl)] border border-danger/40 bg-danger/10 px-3 py-2 text-[13px] text-danger">
                {v.error}
              </div>
            )}
            {m.citations?.length ? (
              <details className="mt-2 text-[12.5px] text-fg-faint">
                <summary className="cursor-pointer hover:text-fg-muted">
                  Использованы фрагменты документов: {m.citations.length}
                </summary>
                <div className="mt-1.5 flex flex-col gap-1.5">
                  {m.citations.map((c, i) => (
                    <div key={i} className="rounded border border-line bg-panel-2 px-2.5 py-1.5 whitespace-pre-wrap text-fg-muted">
                      {c.text}
                    </div>
                  ))}
                </div>
              </details>
            ) : null}
          </div>
        )}

        {!editing && (
          <div
            className={cn(
              'flex min-h-6 flex-wrap items-center gap-x-2 gap-y-1',
              isUser ? 'flex-row-reverse' : '',
              streaming ? 'invisible' : ''
            )}
          >
            <div className="flex items-center opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
              <IconButton label={copied ? 'Скопировано' : 'Копировать'} onClick={copy}>
                <Copy size={14} />
              </IconButton>
              <IconButton label="Изменить" onClick={startEdit}>
                <Pencil size={14} />
              </IconButton>
              {!isUser && (
                <IconButton label="Перегенерировать" onClick={() => void regenerate(m.id)}>
                  <RefreshCw size={14} />
                </IconButton>
              )}
              {!isUser && isLast && (
                <IconButton label="Продолжить ответ" onClick={() => void continueMessage(m.id)}>
                  <StepForward size={14} />
                </IconButton>
              )}
              {currentId && (
                <IconButton label="Ветка: новый чат до этого сообщения" onClick={() => void duplicate(currentId, m.id)}>
                  <GitBranch size={14} />
                </IconButton>
              )}
              <IconButton label="Удалить сообщение" onClick={() => void deleteMessage(m.id)}>
                <Trash2 size={14} />
              </IconButton>
            </div>
            {m.versions.length > 1 && (
              <div className="tabular flex items-center text-[12px] text-fg-faint">
                <IconButton label="Предыдущая версия" className="h-6 w-6" disabled={m.activeVersion === 0} onClick={() => void switchVersion(m.id, -1)}>
                  <ChevronLeft size={14} />
                </IconButton>
                {m.activeVersion + 1} / {m.versions.length}
                <IconButton
                  label="Следующая версия"
                  className="h-6 w-6"
                  disabled={m.activeVersion === m.versions.length - 1}
                  onClick={() => void switchVersion(m.id, 1)}
                >
                  <ChevronRight size={14} />
                </IconButton>
              </div>
            )}
            {!isUser && v.stats && <Stats s={v.stats} />}
          </div>
        )}
      </div>
    </div>
  )
})
