import { ArrowUp, Bot, Folder, Paperclip, Square } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { Attachment } from '@shared/types'
import { normalizeImages } from '@/lib/images'
import { call } from '@/lib/api'
import { agentHint, truncateMiddle } from '@/lib/agent'
import { cn } from '@/lib/format'
import { friendlyError } from '@/lib/text'
import { useChat } from '@/store/chat'
import { useEngine, useModels, useSettings } from '@/store/app'
import { IconButton } from '@/components/ui/Button'
import { AttachmentChips } from './MessageItem'

/** Переключатель режима агента, рабочая папка и подсказка. */
function AgentControls(): React.JSX.Element {
  const agent = useChat((s) => s.current?.agent)
  const setAgent = useChat((s) => s.setAgent)
  const setError = useChat((s) => s.setError)
  // Пока в этом диалоге идёт генерация, режим не меняем.
  const locked = useChat((s) => s.activeConvId !== null && s.activeConvId === s.currentId)
  const enabled = agent?.enabled ?? false
  const cwd = agent?.cwd ?? ''

  const pickFolder = async (): Promise<void> => {
    try {
      const dir = await call('app:pickFolder', 'Рабочая папка агента')
      if (dir) await setAgent({ cwd: dir })
    } catch (e) {
      setError(`Не удалось выбрать папку: ${friendlyError(e)}`)
    }
  }

  return (
    <>
      <button
        type="button"
        role="switch"
        aria-checked={enabled}
        disabled={locked}
        onClick={() => void setAgent({ enabled: !enabled })}
        title={
          enabled
            ? 'Режим агента включён: модель может читать и менять файлы и запускать команды'
            : 'Включить режим агента: модель сможет читать и менять файлы и запускать команды'
        }
        className={cn(
          'flex h-7 shrink-0 items-center gap-1.5 rounded-[var(--radius-ctl)] px-2 text-[12.5px] transition-colors disabled:opacity-45',
          enabled ? 'bg-accent-soft font-medium text-accent-strong' : 'text-fg-faint hover:bg-panel-2 hover:text-fg'
        )}
      >
        <Bot size={15} aria-hidden />
        Агент
      </button>
      {enabled && (
        <button
          type="button"
          disabled={locked}
          onClick={() => void pickFolder()}
          aria-label={cwd ? `Рабочая папка ${cwd}. Изменить папку` : 'Выбрать рабочую папку'}
          title={cwd ? `Рабочая папка агента: ${cwd}\nНажмите, чтобы изменить папку` : 'Выбрать рабочую папку агента'}
          className="flex h-7 min-w-0 items-center gap-1.5 rounded-[var(--radius-ctl)] border border-line px-2 text-[12px] text-fg-muted transition-colors hover:border-line-strong hover:text-fg disabled:opacity-45"
        >
          <Folder size={13} className="shrink-0" aria-hidden />
          {cwd ? (
            <span className="min-w-0 truncate font-mono">{truncateMiddle(cwd, 44)}</span>
          ) : (
            <span className="text-warn">Выбрать папку</span>
          )}
        </button>
      )}
    </>
  )
}

/** Строка под полем ввода в режиме агента: что он может и что будет спрошено. */
function AgentHintLine(): React.JSX.Element | null {
  const agent = useChat((s) => s.current?.agent)
  const setAgent = useChat((s) => s.setAgent)
  const locked = useChat((s) => s.activeConvId !== null && s.activeConvId === s.currentId)
  const approval = useSettings((s) => s.settings?.agent?.approval ?? 'askDangerous')
  if (!agent?.enabled) return null
  return (
    <p data-testid="agent-hint" className="mx-auto max-w-[860px] px-1 pt-1.5 text-[11.5px] leading-snug text-fg-faint">
      {agentHint(approval, !!agent.allowAll)}
      {agent.allowAll && (
        <button
          type="button"
          disabled={locked}
          onClick={() => void setAgent({ allowAll: false })}
          className="ml-1.5 text-fg-muted underline underline-offset-2 hover:text-fg disabled:opacity-45"
        >
          Снова спрашивать
        </button>
      )}
    </p>
  )
}

function readAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result).split(',')[1] ?? '')
    r.onerror = () => reject(r.error)
    r.readAsDataURL(file)
  })
}

export function Composer(): React.JSX.Element {
  const send = useChat((s) => s.send)
  const stop = useChat((s) => s.stop)
  const setError = useChat((s) => s.setError)
  const current = useChat((s) => s.current)
  const agentMode = useChat((s) => s.current?.agent?.enabled ?? false)
  const prefill = useChat((s) => s.prefill)
  const generating = useChat((s) => s.activeConvId !== null)
  const status = useEngine((s) => s.status)
  const loadedModel = useModels((s) => s.models.find((m) => m.id === status.modelId))
  const [text, setText] = useState('')
  const [atts, setAtts] = useState<Attachment[]>([])
  const [busy, setBusy] = useState(false)
  const [drag, setDrag] = useState(false)
  const ref = useRef<HTMLTextAreaElement>(null)
  const ready = status.state === 'ready'
  // Картинки понимает только модель с проектором (mmproj).
  const vision = status.vision ?? loadedModel?.vision ?? false

  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(260, el.scrollHeight)}px`
  }, [text])

  // Пример задачи из пустого чата агента подставляется в поле — отправляет пользователь.
  useEffect(() => {
    if (prefill === null) return
    setText(prefill)
    useChat.getState().setPrefill(null)
    ref.current?.focus()
  }, [prefill])

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
      const added = await normalizeImages(await call('attachments:add', paths))
      setAtts((a) => [...a, ...added])
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const submit = (): void => {
    const t = text.trim()
    if ((!t && !atts.length) || generating || busy) return
    if (!ready) {
      setError('Сначала загрузите модель: выберите её в верхней панели и нажмите «Загрузить».')
      return
    }
    if (!vision && atts.some((a) => a.kind === 'image')) {
      setError('Загруженная модель не понимает изображения. Уберите картинку или загрузите vision-модель (с файлом mmproj).')
      return
    }
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
              .then((added) => normalizeImages(added))
              .then((added) => setAtts((a) => [...a, ...added]))
              .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
              .finally(() => setBusy(false))
          }}
          aria-label="Сообщение"
          placeholder={
            !ready
              ? 'Сначала загрузите модель вверху экрана'
              : agentMode
                ? 'Задача для агента… (Enter — отправить, Shift+Enter — новая строка)'
                : 'Сообщение… (Enter — отправить, Shift+Enter — новая строка)'
          }
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
          <AgentControls />
          <div className="flex-1" />
          {usage && (
            <span
              className={cn('tabular text-[11.5px]', usage.pct > 90 ? 'text-danger' : usage.pct > 70 ? 'text-warn' : 'text-fg-faint')}
              title={`Использовано ${usage.used.toLocaleString('ru-RU')} из ${usage.ctx.toLocaleString('ru-RU')} токенов контекста`}
            >
              Контекст {usage.pct}%
            </span>
          )}
          {generating ? (
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
              disabled={(!text.trim() && !atts.length) || busy || !ready}
              className="grid h-8 w-8 place-items-center rounded-full bg-accent text-accent-ink hover:bg-accent-hover disabled:bg-raised disabled:text-fg-faint"
              aria-label="Отправить"
              title={ready ? 'Отправить' : 'Сначала загрузите модель'}
            >
              <ArrowUp size={17} strokeWidth={2.4} />
            </button>
          )}
        </div>
      </div>
      <AgentHintLine />
    </div>
  )
}
