import { ArrowDown, X } from 'lucide-react'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useChat } from '@/store/chat'
import { useEngine, useModels } from '@/store/app'
import { MessageItem } from './MessageItem'
import { Composer } from './Composer'

function EmptyState(): React.JSX.Element {
  const status = useEngine((s) => s.status)
  const models = useModels((s) => s.models)
  const model = models.find((m) => m.id === status.modelId)
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
  const { current, streamingId, error, setError } = useChat()
  const scroller = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  const [showDown, setShowDown] = useState(false)
  const messages = useMemo(() => current?.messages ?? [], [current])

  // Держимся низа, пока пользователь сам не прокрутил вверх.
  useLayoutEffect(() => {
    const el = scroller.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  }, [messages])

  useEffect(() => {
    stick.current = true
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
            <button onClick={() => setError(null)} aria-label="Закрыть">
              <X size={14} />
            </button>
          </div>
        </div>
      )}
      <Composer />
    </div>
  )
}
