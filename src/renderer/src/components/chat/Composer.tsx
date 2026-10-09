import { ArrowUp, Paperclip, Square } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { Attachment } from '@shared/types'
import { call } from '@/lib/api'
import { cn } from '@/lib/format'
import { useChat } from '@/store/chat'
import { useEngine } from '@/store/app'
import { IconButton } from '@/components/ui/Button'
import { AttachmentChips } from './MessageItem'

function readAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result).split(',')[1] ?? '')
    r.onerror = () => reject(r.error)
    r.readAsDataURL(file)
  })
}

export function Composer(): React.JSX.Element {
  const { send, stop, streamingId, current, setError } = useChat()
  const status = useEngine((s) => s.status)
  const [text, setText] = useState('')
  const [atts, setAtts] = useState<Attachment[]>([])
  const [busy, setBusy] = useState(false)
  const [drag, setDrag] = useState(false)
  const ref = useRef<HTMLTextAreaElement>(null)
  const ready = status.state === 'ready'
  const streaming = streamingId !== null

  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(260, el.scrollHeight)}px`
  }, [text])

  // Заполненность контекста: по статистике последнего ответа + оценка черновика.
  const usage = useMemo(() => {
    const ctx = status.contextLength ?? 0
    if (!ctx || !current) return null
    let used = 0
    for (let i = current.messages.length - 1; i >= 0; i--) {
      const st = current.messages[i]!.versions[current.messages[i]!.activeVersion]?.stats
      if (st?.promptTokens) {
        used = st.promptTokens + st.completionTokens
        break
      }
    }
    used += Math.ceil(text.length / 3.2)
    return { used, ctx, pct: Math.min(100, Math.round((used / ctx) * 100)) }
  }, [current, status.contextLength, text])

  const addPaths = async (paths: string[]): Promise<void> => {
    if (!paths.length) return
    setBusy(true)
    try {
      const added = await call('attachments:add', paths)
      setAtts((a) => [...a, ...added])
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const submit = (): void => {
    const t = text.trim()
    if ((!t && !atts.length) || streaming || busy) return
    void send(t, atts)
    setText('')
    setAtts([])
  }

  return (
    <div className="px-6 pb-4">
      <div
        className={cn(
          'mx-auto flex max-w-[860px] flex-col gap-2 rounded-[14px] border bg-panel px-3 pt-2.5 pb-2 transition-colors',
          drag ? 'border-accent' : 'border-line-strong/70 focus-within:border-line-strong'
        )}
        onDragOver={(e) => {
          e.preventDefault()
          setDrag(true)
        }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => {
          e.preventDefault()
          setDrag(false)
          const paths = [...e.dataTransfer.files].map((f) => window.nys.pathForFile(f)).filter(Boolean)
          void addPaths(paths)
        }}
      >
        {atts.length > 0 && <AttachmentChips items={atts} onRemove={(id) => setAtts((a) => a.filter((x) => x.id !== id))} />}
        <textarea
          ref={ref}
          value={text}
          rows={1}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              submit()
            }
          }}
          onPaste={(e) => {
            const files = [...e.clipboardData.files].filter((f) => f.type.startsWith('image/'))
            if (!files.length) return
            e.preventDefault()
            setBusy(true)
            void Promise.all(
              files.map(async (f) =>
                call('attachments:addData', f.name || `image-${Date.now()}.png`, f.type, await readAsBase64(f))
              )
            )
              .then((added) => setAtts((a) => [...a, ...added]))
              .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
              .finally(() => setBusy(false))
          }}
          placeholder={ready ? 'Сообщение… (Enter — отправить, Shift+Enter — новая строка)' : 'Сначала загрузите модель вверху экрана'}
          className="max-h-[260px] min-h-[24px] w-full resize-none bg-transparent px-1 text-[14.5px] leading-[1.5] text-fg outline-none placeholder:text-fg-faint"
        />
        <div className="flex items-center gap-2">
          <IconButton
            label="Прикрепить файлы или изображения"
            disabled={busy}
            onClick={() => void call('attachments:pick').then(addPaths)}
          >
            <Paperclip size={16} />
          </IconButton>
          <div className="flex-1" />
          {usage && (
            <span
              className={cn('tabular text-[11.5px]', usage.pct > 90 ? 'text-danger' : usage.pct > 70 ? 'text-warn' : 'text-fg-faint')}
              title={`Использовано ${usage.used.toLocaleString('ru-RU')} из ${usage.ctx.toLocaleString('ru-RU')} токенов контекста`}
            >
              Контекст {usage.pct}%
            </span>
          )}
          {streaming ? (
            <button
              onClick={() => void stop()}
              className="grid h-8 w-8 place-items-center rounded-full bg-fg text-bg hover:opacity-85"
              aria-label="Остановить генерацию"
              title="Остановить"
            >
              <Square size={13} fill="currentColor" />
            </button>
          ) : (
            <button
              onClick={submit}
              disabled={(!text.trim() && !atts.length) || busy}
              className="grid h-8 w-8 place-items-center rounded-full bg-accent text-accent-ink hover:bg-accent-strong disabled:bg-raised disabled:text-fg-faint"
              aria-label="Отправить"
              title="Отправить"
            >
              <ArrowUp size={17} strokeWidth={2.4} />
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
