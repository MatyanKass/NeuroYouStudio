import { ArrowDown, ShieldAlert, X } from 'lucide-react'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { AGENT_EXAMPLES, awaitingCalls, baseName } from '@/lib/agent'
import { useChat } from '@/store/chat'
import { useEngine, useModels } from '@/store/app'
import { Onboarding, useNeedsOnboarding } from './Onboarding'
import { MessageItem } from './MessageItem'
import { Composer } from './Composer'

function AgentEmptyState({ ready }: { ready: boolean }): React.JSX.Element {
  const cwd = useChat((s) => s.current?.agent?.cwd ?? '')
  const setPrefill = useChat((s) => s.setPrefill)
  return (
    <div data-testid="agent-empty" className="mx-auto flex h-full max-w-[560px] flex-col justify-center gap-3 px-6 pb-16">
      <h2 className="text-[22px] font-semibold tracking-tight text-fg">Режим агента</h2>
      <p className="text-[14px] text-fg-muted">
        Опишите задачу: агент сам прочитает нужные файлы
        {cwd ? (
          <>
            {' '}
            в папке <span className="font-mono text-[13px] whitespace-nowrap text-fg" title={cwd}>{baseName(cwd)}</span>
          </>
        ) : null}
        , внесёт правки и запустит команды.
        {ready ? '' : ' Сначала загрузите модель в верхней панели.'}
      </p>
      <div className="flex flex-col gap-1.5 pt-1">
        <span className="text-[12.5px] text-fg-faint">Например</span>
        {AGENT_EXAMPLES.map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setPrefill(t)}
            className="rounded-[var(--radius-ctl)] border border-line bg-panel px-3 py-2 text-left text-[13.5px] text-fg-muted transition-colors hover:border-line-strong hover:text-fg"
          >
            {t}
          </button>
        ))}
      </div>
    </div>
  )
}

function EmptyState(): React.JSX.Element {
  const status = useEngine((s) => s.status)
  const models = useModels((s) => s.models)
  const agent = useChat((s) => s.current?.agent?.enabled ?? false)
  const model = models.find((m) => m.id === status.modelId)
  const needsOnboarding = useNeedsOnboarding()
  if (status.state !== 'ready' && needsOnboarding) return <Onboarding />
  if (agent) return <AgentEmptyState ready={status.state === 'ready'} />
  return (
    <div className="mx-auto flex h-full max-w-[560px] flex-col justify-center gap-3 px-6 pb-16">
      {status.state === 'ready' && model ? (
        <>
          <h2 className="text-[22px] font-semibold tracking-tight text-fg">{model.name}</h2>
          <p className="text-[14px] text-fg-muted">
            Модель загружена. Напишите сообщение, прикрепите документ или картинку
            {model.vision ? '' : ' (картинки понимают только vision-модели)'}.
          </p>
        </>
      ) : (
        <>
          <h2 className="text-[22px] font-semibold tracking-tight text-fg">Выберите модель</h2>
          <p className="text-[14px] text-fg-muted">
            {models.length
              ? 'Откройте список моделей в верхней панели и нажмите «Загрузить». Распределение памяти между видеокартой и RAM настраивается во вкладке «Память» справа.'
              : 'Моделей пока нет. Найдите и скачайте модель в разделе «Поиск».'}
          </p>
        </>
      )}
    </div>
  )
}

export function ChatView(): React.JSX.Element {
  const current = useChat((s) => s.current)
  const streamingId = useChat((s) => s.streamingId)
  const error = useChat((s) => s.error)
  const setError = useChat((s) => s.setError)
  const scroller = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  const [showDown, setShowDown] = useState(false)
  const messages = useMemo(() => current?.messages ?? [], [current])
  // Первое действие агента, ждущее решения, — из последнего ответа.
  const pendingId = useMemo(() => {
    const last = messages[messages.length - 1]
    const v = last?.role === 'assistant' ? last.versions[last.activeVersion] : undefined
    return awaitingCalls(v?.turns)[0]?.id ?? null
  }, [messages])
  const [pendingVisible, setPendingVisible] = useState(true)

  // Видна ли карточка подтверждения: если нет — наверху чата висит кнопка «к ней».
  useEffect(() => {
    const root = scroller.current
    const el = pendingId ? document.getElementById(`approval-${pendingId}`) : null
    if (!root || !el) {
      setPendingVisible(true)
      return
    }
    const io = new IntersectionObserver(([e]) => setPendingVisible(!!e?.isIntersecting), { root, threshold: 0.25 })
    io.observe(el)
    return () => io.disconnect()
  }, [pendingId])

  const showPending = (): void => {
    const el = pendingId ? document.getElementById(`approval-${pendingId}`) : null
    if (!el) return
    el.scrollIntoView({ block: 'center', behavior: 'smooth' })
    el.focus({ preventScroll: true })
  }

  // Держимся низа, пока пользователь сам не прокрутил вверх.
  useLayoutEffect(() => {
    const el = scroller.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  }, [messages])

  useEffect(() => {
    stick.current = true
    setShowDown(false)
  }, [current?.id])

  const onScroll = (): void => {
    const el = scroller.current
    if (!el) return
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60
    stick.current = atBottom
    setShowDown(!atBottom)
  }

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div ref={scroller} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto">
        {messages.length === 0 ? (
          <EmptyState />
        ) : (
          <div className="mx-auto flex max-w-[860px] flex-col gap-6 px-6 pt-6 pb-4">
            {messages.map((m, i) => (
              <MessageItem key={m.id} m={m} isLast={i === messages.length - 1} streaming={streamingId === m.id} />
            ))}
          </div>
        )}
      </div>
      {pendingId && !pendingVisible && (
        <button
          data-testid="approval-pill"
          onClick={showPending}
          className="absolute top-3 left-1/2 z-10 flex h-8 -translate-x-1/2 items-center gap-1.5 rounded-full border border-warn/50 bg-panel px-3 text-[12.5px] text-warn shadow-[0_6px_24px_rgba(0,0,0,0.3)] hover:bg-panel-2"
        >
          <ShieldAlert size={14} aria-hidden />
          Агент ждёт подтверждения
        </button>
      )}
      {showDown && (
        <button
          onClick={() => {
            stick.current = true
            scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: 'smooth' })
          }}
          className="absolute bottom-28 left-1/2 grid h-8 w-8 -translate-x-1/2 place-items-center rounded-full border border-line-strong bg-panel text-fg-muted hover:text-fg"
          aria-label="Вниз"
        >
          <ArrowDown size={15} />
        </button>
      )}
      {error && (
        <div className="mx-auto mb-2 flex w-full max-w-[860px] items-start gap-2 px-6">
          <div className="flex flex-1 items-start gap-2 rounded-[var(--radius-ctl)] border border-danger/40 bg-danger/10 px-3 py-2 text-[13px] text-danger">
            <span className="flex-1">{error}</span>
            <button onClick={() => setError(null)} aria-label="Закрыть сообщение об ошибке" title="Закрыть">
              <X size={14} />
            </button>
          </div>
        </div>
      )}
      <Composer />
    </div>
  )
}
