import { Check, Download, ExternalLink, Heart, KeyRound, Lock, Search, X } from 'lucide-react'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { create } from 'zustand'
import type { ModelFormat } from '@shared/config'
import type { HfSearchQuery } from '@shared/ipc'
import type { DownloadItem, HardwareInfo, HfFileOption, HfModelDetails, HfModelSummary } from '@shared/types'
import { Markdown } from '@/components/chat/Markdown'
import { FitBadge } from '@/components/FitBadge'
import { Button } from '@/components/ui/Button'
import { Hint, Select } from '@/components/ui/Field'
import { EmptyState, InlineError, ProgressBar, Tag } from '@/components/ui/Page'
import { Segmented } from '@/components/ui/Segmented'
import { call } from '@/lib/api'
import { useHardwareInfo } from '@/lib/ensure'
import { cn, formatBytes, formatCount, formatMiB, formatRelative } from '@/lib/format'
import { friendlyError } from '@/lib/text'
import { useDownloads, useSettings } from '@/store/app'
import { useUi } from '@/store/ui'

type Sort = HfSearchQuery['sort']

const SORTS: Array<{ value: Sort; label: string }> = [
  { value: 'downloads', label: 'Популярные' },
  { value: 'likes', label: 'По лайкам' },
  { value: 'lastModified', label: 'Недавние' },
  { value: 'trendingScore', label: 'В тренде' }
]

const FORMAT_NOTE: Record<ModelFormat, string> = {
  gguf: 'GGUF запускается через llama.cpp и ik_llama.cpp: если модель не помещается в видеокарту, часть уходит в RAM.',
  exl3: 'EXL3 запускается через ExLlamaV3 — это быстрее всего, но модель должна целиком помещаться в VRAM.'
}

const ACTIVE_STATES: Array<DownloadItem['state']> = ['queued', 'downloading', 'paused']

// Состояние поиска переживает переход между разделами.
interface DiscoverState {
  input: string
  format: ModelFormat
  sort: Sort
  selected: string | null
  results: HfModelSummary[]
  resultsKey: string
}

const useDiscover = create<DiscoverState>(() => ({
  input: '',
  format: 'gguf',
  sort: 'downloads',
  selected: null,
  results: [],
  resultsKey: ''
}))

/** «user/repo» или ссылка на huggingface.co → id репозитория. */
function parseRepoInput(raw: string): { query: string; repoId: string | null } {
  const s = raw.trim()
  const url = /^(?:https?:\/\/)?(?:www\.)?(?:huggingface\.co|hf\.co)\/(?!datasets\/|spaces\/|models\b)([\w.-]+\/[\w.-]+)/i.exec(s)
  if (url?.[1]) return { query: url[1], repoId: url[1] }
  if (/^[\w.-]+\/[\w.-]+$/.test(s)) return { query: s, repoId: s }
  return { query: s, repoId: null }
}

const splitId = (id: string): { author: string; name: string } => {
  const i = id.indexOf('/')
  return i < 0 ? { author: '', name: id } : { author: id.slice(0, i), name: id.slice(i + 1) }
}

/** Рекомендуемый вариант: самый большой, что целиком влезает в VRAM; иначе самый большой из частичных. */
function recommendedKey(options: HfFileOption[]): string | null {
  const pick = (fit: HfFileOption['fit']): HfFileOption | undefined =>
    options.filter((o) => o.fit === fit).sort((a, b) => b.sizeBytes - a.sizeBytes)[0]
  return (pick('full') ?? pick('partial'))?.key ?? null
}

function defaultMmproj(list: HfFileOption[]): string | null {
  const by = (re: RegExp): HfFileOption | undefined => list.find((o) => re.test(o.quant) || re.test(o.label))
  return (by(/^F16$/i) ?? by(/^BF16$/i) ?? by(/(^|[^B])F16/i) ?? by(/BF16/i) ?? list[0])?.key ?? null
}

export function DiscoverPage(): React.JSX.Element {
  const { input, format, sort, selected, results, resultsKey } = useDiscover()
  const [searching, setSearching] = useState(false)
  const [searchError, setSearchError] = useState<string | null>(null)
  const [retryTick, setRetryTick] = useState(0)
  const reqRef = useRef(0)
  const lastRetry = useRef(0)

  // Поиск с задержкой 400 мс. Ссылка или «user/repo» сразу открывает этот репозиторий справа.
  useEffect(() => {
    const { query, repoId } = parseRepoInput(input)
    const key = `${query}|${format}|${sort}`
    const forced = retryTick !== lastRetry.current
    lastRetry.current = retryTick
    const timers: Array<ReturnType<typeof setTimeout>> = []
    if (repoId && useDiscover.getState().selected !== repoId) {
      timers.push(setTimeout(() => useDiscover.setState({ selected: repoId }), 400))
    }
    if (forced || key !== useDiscover.getState().resultsKey) {
      const id = ++reqRef.current
      timers.push(
        setTimeout(() => {
          setSearching(true)
          setSearchError(null)
          call('hf:search', { query, format, sort, limit: 50 })
            .then((r) => {
              if (id === reqRef.current) useDiscover.setState({ results: r, resultsKey: key })
            })
            .catch((e: unknown) => {
              if (id !== reqRef.current) return
              setSearchError(friendlyError(e))
              useDiscover.setState({ results: [], resultsKey: '' })
            })
            .finally(() => {
              if (id === reqRef.current) setSearching(false)
            })
        }, 400)
      )
    } else {
      // Вернулись к уже показанному запросу — старый ответ больше не нужен.
      reqRef.current++
      setSearching(false)
    }
    return () => timers.forEach(clearTimeout)
  }, [input, format, sort, retryTick])

  const setFormat = (f: ModelFormat): void => {
    if (f === format) return
    const keep = parseRepoInput(input).repoId
    useDiscover.setState({ format: f, selected: keep ?? null })
  }

  const summary = results.find((r) => r.id === selected)

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="shrink-0 border-b border-line px-6 pt-3 pb-2.5">
        <div className="flex items-center gap-2">
          <h1 className="mr-2 shrink-0 text-[16px] font-semibold text-fg">Поиск моделей</h1>
          <label className="relative min-w-0 flex-1">
            <Search size={15} className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-fg-faint" />
            <input
              value={input}
              autoFocus
              onChange={(e) => useDiscover.setState({ input: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === 'Escape') useDiscover.setState({ input: '' })
              }}
              placeholder="Название, автор/репозиторий или ссылка на Hugging Face"
              aria-label="Поиск на Hugging Face"
              className="h-[34px] w-full rounded-[var(--radius-ctl)] border border-line bg-bg pr-8 pl-8 text-[13.5px] text-fg outline-none placeholder:text-fg-faint focus:border-accent"
            />
            {input && (
              <button
                aria-label="Очистить поиск"
                title="Очистить поиск"
                onClick={() => useDiscover.setState({ input: '' })}
                className="absolute top-1/2 right-2 grid h-5 w-5 -translate-y-1/2 place-items-center rounded text-fg-faint hover:text-fg"
              >
                <X size={14} />
              </button>
            )}
          </label>
          <Segmented
            label="Формат"
            value={format}
            onChange={setFormat}
            options={[
              { value: 'gguf', label: 'GGUF', title: 'Для llama.cpp: может частично лежать в RAM' },
              { value: 'exl3', label: 'EXL3', title: 'Для ExLlamaV3: быстрее всего, если модель целиком в VRAM' }
            ]}
          />
          <Select
            label="Сортировка"
            value={sort}
            onChange={(v) => useDiscover.setState({ sort: v })}
            options={SORTS}
            className="h-[30px] max-w-none"
          />
        </div>
        <p className="mt-1.5 text-[12.5px] text-fg-faint">{FORMAT_NOTE[format]}</p>
      </header>

      <div className="flex min-h-0 flex-1">
        <div className="flex w-[300px] shrink-0 flex-col border-r border-line xl:w-[340px]">
          <div className="flex h-8 shrink-0 items-center justify-between px-4 text-[12px] text-fg-faint">
            <span>{searching ? 'Ищем…' : results.length ? `Найдено: ${results.length}` : ''}</span>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto" aria-busy={searching}>
            {searchError ? (
              <div className="px-3 py-2">
                <InlineError
                  message={`Поиск не удался: ${searchError}`}
                  onRetry={() => setRetryTick((n) => n + 1)}
                />
              </div>
            ) : results.length === 0 && !searching && resultsKey ? (
              <div className="px-4 py-6 text-[13px] text-fg-muted">
                Ничего не найдено. Попробуйте другое название или переключите формат на{' '}
                {format === 'gguf' ? 'EXL3' : 'GGUF'}.
              </div>
            ) : (
              <ul className={cn(searching && 'opacity-60')}>
                {results.map((r) => (
                  <ResultItem
                    key={r.id}
                    item={r}
                    active={r.id === selected}
                    onSelect={() => useDiscover.setState({ selected: r.id })}
                  />
                ))}
              </ul>
            )}
          </div>
        </div>

        <div className="min-w-0 flex-1 overflow-y-auto">
          {selected ? (
            <RepoDetails key={`${selected}|${format}`} repoId={selected} format={format} summary={summary} />
          ) : (
            <EmptyState
              icon={<Search size={28} strokeWidth={1.5} />}
              title="Выберите модель слева"
              className="py-24"
            >
              Здесь появятся варианты квантования с оценкой, поместится ли модель в вашу видеокарту. Можно сразу
              вставить ссылку на репозиторий Hugging Face в строку поиска.
            </EmptyState>
          )}
        </div>
      </div>
    </div>
  )
}

function ResultItem({
  item,
  active,
  onSelect
}: {
  item: HfModelSummary
  active: boolean
  onSelect: () => void
}): React.JSX.Element {
  const { author, name } = splitId(item.id)
  const updated = Date.parse(item.lastModified)
  const ref = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (active) ref.current?.scrollIntoView({ block: 'nearest' })
  }, [active])
  return (
    <li>
      <button
        ref={ref}
        onClick={onSelect}
        aria-current={active || undefined}
        className={cn(
          'block w-full border-b border-line px-4 py-2.5 text-left transition-colors',
          active ? 'bg-accent-soft' : 'hover:bg-panel'
        )}
      >
        <div className="flex min-w-0 items-center gap-1.5">
          <span className={cn('truncate text-[13.5px]', active ? 'text-fg font-medium' : 'text-fg')} title={item.id}>
            {name}
          </span>
          {item.gated && <Lock size={12} className="shrink-0 text-fg-faint" aria-label="Закрытая модель" />}
        </div>
        <div className="mt-0.5 flex min-w-0 items-center gap-3 text-[12px] text-fg-faint">
          <span className="min-w-0 truncate">{author}</span>
          <span className="tabular ml-auto flex shrink-0 items-center gap-1" title="Скачиваний за месяц">
            <Download size={11} />
            {formatCount(item.downloads)}
          </span>
          <span className="tabular flex shrink-0 items-center gap-1" title="Лайков">
            <Heart size={11} />
            {formatCount(item.likes)}
          </span>
          {Number.isFinite(updated) && (
            <span className="shrink-0" title={`Обновлено ${new Date(updated).toLocaleString('ru-RU')}`}>
              {formatRelative(updated)}
            </span>
          )}
        </div>
      </button>
    </li>
  )
}

function HardwareLine({ info }: { info: HardwareInfo | null }): React.JSX.Element {
  if (!info) return <span>Железо не определено, поэтому оценка «поместится ли» может отсутствовать.</span>
  const gpu = info.gpus[0]
  const vram = info.gpus.reduce((s, g) => s + g.vramTotalMiB, 0)
  if (!gpu)
    return (
      <span>
        Видеокарта NVIDIA не найдена: оценка для работы на процессоре, RAM {formatMiB(info.ramTotalMiB)}.
      </span>
    )
  return (
    <span>
      Оценка для <span className="text-fg-muted">{info.gpus.length > 1 ? `${info.gpus.length} видеокарт` : gpu.name}</span>{' '}
      с <span className="tabular text-fg-muted">{formatMiB(vram)}</span> VRAM и{' '}
      <span className="tabular text-fg-muted">{formatMiB(info.ramTotalMiB)}</span> RAM, контекст около 8K
    </span>
  )
}

function RepoDetails({
  repoId,
  format,
  summary
}: {
  repoId: string
  format: ModelFormat
  summary: HfModelSummary | undefined
}): React.JSX.Element {
  const hasToken = useSettings((s) => s.settings?.hasHfToken ?? false)
  const { info: hw } = useHardwareInfo()
  const downloads = useDownloads((s) => s.items)
  const setPage = useUi((s) => s.setPage)

  const [details, setDetails] = useState<HfModelDetails | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [tick, setTick] = useState(0)
  const [starting, setStarting] = useState<string | null>(null)
  const [startError, setStartError] = useState<string | null>(null)
  const [withMmproj, setWithMmproj] = useState(true)
  const [mmprojKey, setMmprojKey] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    setError(null)
    call('hf:details', repoId, format)
      .then((d) => {
        if (!alive) return
        setDetails(d)
        setMmprojKey((k) => k ?? defaultMmproj(d.mmproj))
      })
      .catch((e: unknown) => alive && setError(friendlyError(e)))
    return () => {
      alive = false
    }
  }, [repoId, format, tick])

  const { author, name } = splitId(repoId)
  const gated = details?.gated ?? summary?.gated ?? false
  const blocked = gated && !hasToken
  const recommended = useMemo(() => (details ? recommendedKey(details.options) : null), [details])
  const options = useMemo(
    () => (details ? [...details.options].sort((a, b) => a.sizeBytes - b.sizeBytes) : []),
    [details]
  )
  const updated = summary ? Date.parse(summary.lastModified) : NaN

  const start = async (opt: HfFileOption): Promise<void> => {
    setStarting(opt.key)
    setStartError(null)
    try {
      const mm = details && details.mmproj.length > 0 && withMmproj ? (mmprojKey ?? undefined) : undefined
      await call('downloads:start', repoId, format, opt.key, mm)
    } catch (e) {
      setStartError(`Не удалось начать загрузку: ${friendlyError(e)}`)
    } finally {
      setStarting(null)
    }
  }

  const retryDownload = (id: string): void => {
    call('downloads:resume', id).catch((e: unknown) => setStartError(friendlyError(e)))
  }

  return (
    <div className="mx-auto max-w-[920px] px-6 pt-5 pb-10">
      <div className="flex items-start gap-4">
        <div className="min-w-0 flex-1">
          <div className="truncate text-[12.5px] text-fg-muted">{author}</div>
          <h2 className="text-[18px] leading-tight font-semibold break-words text-fg">{name}</h2>
          {summary && (
            <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-[12.5px] text-fg-faint">
              <span className="tabular flex items-center gap-1">
                <Download size={12} />
                {summary.downloads.toLocaleString('ru-RU')} скачиваний
              </span>
              <span className="tabular flex items-center gap-1">
                <Heart size={12} />
                {summary.likes.toLocaleString('ru-RU')}
              </span>
              {Number.isFinite(updated) && <span>Обновлено {formatRelative(updated)}</span>}
              {gated && (
                <span className="flex items-center gap-1">
                  <Lock size={12} />
                  Закрытая
                </span>
              )}
            </div>
          )}
        </div>
        <Button
          size="sm"
          variant="ghost"
          icon={<ExternalLink size={13} />}
          onClick={() => void call('app:openExternal', `https://huggingface.co/${repoId}`).catch(() => undefined)}
        >
          Открыть на Hugging Face
        </Button>
      </div>

      {blocked && (
        <div className="mt-4 flex items-center gap-3 rounded-[var(--radius-ctl)] border border-warn/30 bg-warn/8 px-3 py-2.5 text-[13px] text-fg">
          <KeyRound size={16} className="shrink-0 text-warn" />
          <span className="flex-1">Модель закрытая — добавьте токен Hugging Face в настройках.</span>
          <Button size="sm" onClick={() => setPage('settings')}>
            Открыть настройки
          </Button>
        </div>
      )}
      {gated && hasToken && (
        <p className="mt-4 text-[12.5px] text-fg-muted">
          Модель закрытая. Если загрузка не начнётся, примите условия использования на странице модели на Hugging Face.
        </p>
      )}

      <section className="mt-6">
        <div className="flex items-baseline justify-between gap-3">
          <h3 className="text-[14px] font-semibold text-fg">Варианты</h3>
          <span className="min-w-0 text-right text-[12px] text-fg-faint">
            <HardwareLine info={hw} />
          </span>
        </div>

        {error ? (
          <InlineError className="mt-3" message={`Не удалось получить сведения о модели: ${error}`} onRetry={() => setTick((n) => n + 1)} />
        ) : !details ? (
          <div className="mt-3 space-y-2" aria-busy>
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="h-9 animate-pulse rounded-[var(--radius-ctl)] bg-panel" />
            ))}
          </div>
        ) : options.length === 0 ? (
          <p className="mt-3 text-[13px] text-fg-muted">
            В репозитории нет файлов формата {format === 'gguf' ? 'GGUF' : 'EXL3'}. Попробуйте переключить формат или
            найти квантованную версию этой модели.
          </p>
        ) : (
          <>
            {details.mmproj.length > 0 && (
              <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-[var(--radius-ctl)] border border-line bg-panel px-3 py-2 text-[13px]">
                <label className="flex cursor-pointer items-center gap-2 text-fg">
                  <input
                    type="checkbox"
                    className="h-3.5 w-3.5 accent-[var(--color-accent)]"
                    checked={withMmproj}
                    onChange={(e) => setWithMmproj(e.target.checked)}
                  />
                  Скачать vision-проектор
                </label>
                <Select
                  label="Vision-проектор"
                  value={mmprojKey ?? ''}
                  onChange={(v) => setMmprojKey(v)}
                  disabled={!withMmproj}
                  className="max-w-[280px]"
                  options={details.mmproj.map((o) => ({
                    value: o.key,
                    label: `${o.quant || o.label}, ${formatBytes(o.sizeBytes)}${o.downloaded ? ', уже скачан' : ''}`
                  }))}
                />
                <Hint text="Проектор (mmproj) нужен, чтобы модель понимала изображения. Он скачивается вместе с выбранным вариантом в ту же папку." />
              </div>
            )}

            {startError && <InlineError className="mt-3" message={startError} />}

            <div className="mt-3 border-t border-line" role="table" aria-label="Варианты загрузки">
              <div
                role="row"
                className="grid grid-cols-[minmax(0,1fr)_72px_136px_124px] items-center gap-x-3 border-b border-line py-1.5 text-[12px] text-fg-faint"
              >
                <span role="columnheader">Вариант</span>
                <span role="columnheader" className="text-right">
                  Размер
                </span>
                <span role="columnheader">Поместится</span>
                <span role="columnheader" />
              </div>
              {options.map((o) => (
                <OptionRow
                  key={o.key}
                  option={o}
                  recommended={o.key === recommended}
                  download={downloads.find(
                    (d) => d.repo === repoId && d.optionKey === o.key && d.state !== 'canceled'
                  )}
                  blocked={blocked}
                  starting={starting === o.key}
                  onStart={() => void start(o)}
                  onRetry={retryDownload}
                  onOpenDownloads={() => setPage('downloads')}
                />
              ))}
            </div>
          </>
        )}
      </section>

      {details?.description && <Description text={details.description} />}
    </div>
  )
}

function OptionRow({
  option: o,
  recommended,
  download,
  blocked,
  starting,
  onStart,
  onRetry,
  onOpenDownloads
}: {
  option: HfFileOption
  recommended: boolean
  download: DownloadItem | undefined
  blocked: boolean
  starting: boolean
  onStart: () => void
  onRetry: (id: string) => void
  onOpenDownloads: () => void
}): React.JSX.Element {
  const done = o.downloaded || download?.state === 'done'
  const active = download && ACTIVE_STATES.includes(download.state)
  const pct = download && download.totalBytes > 0 ? download.receivedBytes / download.totalBytes : null

  let action: React.JSX.Element
  if (done) {
    action = (
      <Tag tone="ok">
        <Check size={12} />
        Скачано
      </Tag>
    )
  } else if (active && download) {
    action = (
      <button
        onClick={onOpenDownloads}
        title="Открыть раздел «Загрузки»"
        className="flex w-full flex-col gap-1 rounded px-1 py-0.5 text-left hover:bg-panel-2"
      >
        <span className="tabular text-[12px] text-fg-muted">
          {download.state === 'paused' ? 'На паузе' : download.state === 'queued' ? 'В очереди' : 'Загружается'}
          {pct !== null && `, ${Math.floor(pct * 100)}%`}
        </span>
        <ProgressBar value={pct} tone={download.state === 'paused' ? 'muted' : 'accent'} />
      </button>
    )
  } else if (download?.state === 'error') {
    action = (
      <Button size="sm" variant="danger" title={download.error} onClick={() => onRetry(download.id)}>
        Повторить
      </Button>
    )
  } else {
    action = (
      <Button
        size="sm"
        variant={recommended ? 'primary' : 'secondary'}
        disabled={blocked || starting}
        title={blocked ? 'Нужен токен Hugging Face' : undefined}
        onClick={onStart}
        icon={<Download size={13} />}
      >
        Скачать
      </Button>
    )
  }

  return (
    <div
      role="row"
      className={cn(
        'grid grid-cols-[minmax(0,1fr)_72px_136px_124px] items-center gap-x-3 border-b border-line py-2',
        recommended && 'bg-accent-soft/40'
      )}
    >
      <div role="cell" className="flex min-w-0 items-center gap-2 overflow-hidden">
        <span
          title={o.label}
          className={cn(
            'min-w-0 truncate font-mono text-[12.5px]',
            o.quant && 'shrink-0',
            recommended ? 'text-fg' : 'text-fg-muted'
          )}
        >
          {o.quant || o.label}
        </span>
        {o.quant && (
          <span className="hidden min-w-0 truncate text-[12.5px] text-fg-faint xl:inline" title={o.label}>
            {o.label}
          </span>
        )}
        {recommended && (
          <Tag tone="accent" title="Самый крупный вариант, который помещается в вашу видеокарту">
            Рекомендуется
          </Tag>
        )}
      </div>
      <span role="cell" className="tabular text-right text-[13px] text-fg-muted">
        {formatBytes(o.sizeBytes)}
      </span>
      <span role="cell" className="min-w-0">
        {o.fit ? <FitBadge fit={o.fit} note={o.fitNote} /> : <span className="text-fg-faint">—</span>}
      </span>
      <div role="cell" className="flex justify-end">
        {action}
      </div>
    </div>
  )
}

function Description({ text }: { text: string }): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const [tall, setTall] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const el = ref.current
    if (el) setTall(el.scrollHeight > 300)
  }, [text])
  return (
    <section className="mt-8">
      <h3 className="mb-2 text-[14px] font-semibold text-fg">Описание</h3>
      <div ref={ref} className={cn('relative text-[13.5px] text-fg', !expanded && 'max-h-[280px] overflow-hidden')}>
        <Markdown text={text} />
        {tall && !expanded && (
          <div className="pointer-events-none absolute inset-x-0 bottom-0 h-20 bg-gradient-to-t from-bg to-transparent" />
        )}
      </div>
      {tall && (
        <button
          onClick={() => setExpanded(!expanded)}
          className="mt-2 text-[13px] text-fg-muted underline-offset-2 hover:text-fg hover:underline"
        >
          {expanded ? 'Свернуть' : 'Показать полностью'}
        </button>
      )}
    </section>
  )
}
