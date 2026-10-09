import { Download, FolderOpen, Pause, Play, RotateCcw, Search, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { DownloadItem } from '@shared/types'
import { Button, IconButton } from '@/components/ui/Button'
import { EmptyState, InlineError, PageHeader, ProgressBar } from '@/components/ui/Page'
import { call } from '@/lib/api'
import { cn, formatBytes } from '@/lib/format'
import { dirOf, formatEta, friendlyError } from '@/lib/text'
import { useDownloads } from '@/store/app'
import { useUi } from '@/store/ui'

const STATE_LABEL: Record<DownloadItem['state'], string> = {
  queued: 'В очереди',
  downloading: 'Загружается',
  paused: 'На паузе',
  done: 'Готово',
  error: 'Ошибка',
  canceled: 'Отменена'
}

const ORDER: Record<DownloadItem['state'], number> = {
  downloading: 0,
  queued: 1,
  paused: 2,
  error: 3,
  done: 4,
  canceled: 5
}

const FINISHED: Array<DownloadItem['state']> = ['done', 'canceled']

export function DownloadsPage(): React.JSX.Element {
  const items = useDownloads((s) => s.items)
  const setPage = useUi((s) => s.setPage)
  const [error, setError] = useState<string | null>(null)
  const [listError, setListError] = useState<string | null>(null)

  const reload = (): void => {
    setListError(null)
    call('downloads:list')
      .then((list) => useDownloads.setState({ items: list }))
      .catch((e: unknown) => setListError(friendlyError(e)))
  }

  // Подтягиваем список при открытии раздела (события downloads:update обновляют его дальше).
  useEffect(() => {
    let alive = true
    call('downloads:list')
      .then((list) => alive && useDownloads.setState({ items: list }))
      .catch((e: unknown) => alive && setListError(friendlyError(e)))
    return () => {
      alive = false
    }
  }, [])

  const act = (fn: () => Promise<unknown>, what: string): void => {
    setError(null)
    fn().catch((e: unknown) => setError(`Не удалось ${what}: ${friendlyError(e)}`))
  }

  const sorted = [...items].sort((a, b) => ORDER[a.state] - ORDER[b.state])
  const hasFinished = items.some((i) => FINISHED.includes(i.state))
  const active = items.filter((i) => i.state === 'downloading')
  const totalSpeed = active.reduce((s, i) => s + i.speedBps, 0)

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PageHeader title="Загрузки">
        {active.length > 0 && (
          <span className="tabular mr-2 text-[13px] text-fg-muted">
            Скорость {formatBytes(totalSpeed)}/с
          </span>
        )}
        <Button
          size="sm"
          variant="ghost"
          disabled={!hasFinished}
          onClick={() => act(() => call('downloads:clearFinished'), 'очистить список')}
        >
          Очистить завершённые
        </Button>
      </PageHeader>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {(error || listError) && (
          <div className="space-y-2 px-6 pt-3">
            {error && <InlineError message={error} />}
            {listError && <InlineError message={`Список загрузок недоступен: ${listError}`} onRetry={reload} />}
          </div>
        )}

        {items.length === 0 ? (
          <EmptyState
            icon={<Download size={28} strokeWidth={1.5} />}
            title="Загрузок пока нет"
            actions={
              <Button variant="primary" icon={<Search size={14} />} onClick={() => setPage('discover')}>
                Найти модели
              </Button>
            }
          >
            Найдите модель в поиске и нажмите «Скачать» — прогресс появится здесь. Загрузку можно поставить на паузу и
            продолжить позже, даже после перезапуска.
          </EmptyState>
        ) : (
          <ul className="mx-auto max-w-[1040px] px-6 pt-2 pb-8">
            {sorted.map((d) => (
              <DownloadRow
                key={d.id}
                item={d}
                onPause={() => act(() => call('downloads:pause', d.id), 'поставить на паузу')}
                onResume={() => act(() => call('downloads:resume', d.id), 'продолжить загрузку')}
                onCancel={() => act(() => call('downloads:cancel', d.id), 'отменить загрузку')}
                onOpen={() => act(() => call('app:openPath', dirOf(d.targetPath)), 'открыть папку')}
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}

function DownloadRow({
  item: d,
  onPause,
  onResume,
  onCancel,
  onOpen
}: {
  item: DownloadItem
  onPause: () => void
  onResume: () => void
  onCancel: () => void
  onOpen: () => void
}): React.JSX.Element {
  const pct = d.totalBytes > 0 ? Math.min(1, d.receivedBytes / d.totalBytes) : null
  const running = d.state === 'downloading'
  const eta = running && d.speedBps > 0 && d.totalBytes > 0 ? formatEta((d.totalBytes - d.receivedBytes) / d.speedBps) : ''
  const tone = d.state === 'error' ? 'danger' : d.state === 'paused' ? 'muted' : 'accent'
  const showBar = d.state !== 'canceled' && d.state !== 'done'

  return (
    <li className="border-b border-line py-3">
      <div className="flex items-start gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-baseline gap-2">
            <span className="truncate text-[13.5px] font-medium text-fg" title={d.title}>
              {d.title}
            </span>
            <span
              className={cn(
                'shrink-0 text-[12px]',
                d.state === 'error' ? 'text-danger' : d.state === 'done' ? 'text-ok' : 'text-fg-faint'
              )}
            >
              {STATE_LABEL[d.state]}
            </span>
          </div>
          <div className="mt-0.5 flex min-w-0 items-center gap-3 text-[12px] text-fg-faint">
            <span className="shrink-0 text-fg-muted">{d.repo}</span>
            <span className="min-w-0 truncate font-mono text-[11.5px]" title={d.optionKey}>
              {d.optionKey}
            </span>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          {(running || d.state === 'queued') && (
            <IconButton label="Пауза" onClick={onPause}>
              <Pause size={15} />
            </IconButton>
          )}
          {d.state === 'paused' && (
            <IconButton label="Продолжить" onClick={onResume}>
              <Play size={15} />
            </IconButton>
          )}
          {d.state === 'error' && (
            <Button size="sm" variant="ghost" icon={<RotateCcw size={13} />} onClick={onResume}>
              Повторить
            </Button>
          )}
          {d.state === 'done' && (
            <Button size="sm" variant="ghost" icon={<FolderOpen size={13} />} onClick={onOpen}>
              Открыть папку
            </Button>
          )}
          {d.state !== 'done' && d.state !== 'canceled' && (
            <IconButton label="Отменить загрузку" onClick={onCancel} className="hover:text-danger!">
              <X size={15} />
            </IconButton>
          )}
        </div>
      </div>

      {showBar && (
        <div className="mt-2 flex items-center gap-4">
          <ProgressBar
            value={pct}
            tone={tone}
            label={`Прогресс загрузки ${d.title}`}
            className="flex-1"
          />
          <span className="tabular w-[64px] shrink-0 text-right text-[12px] text-fg-muted">
            {pct !== null ? `${Math.floor(pct * 100)}%` : ''}
          </span>
        </div>
      )}

      <div className="tabular mt-1.5 flex min-w-0 flex-wrap items-center gap-x-4 gap-y-0.5 text-[12px] text-fg-faint">
        {d.state !== 'canceled' &&
          (d.totalBytes > 0 ? (
            <span>
              {d.state === 'done' || d.receivedBytes === 0
                ? formatBytes(d.totalBytes)
                : `${formatBytes(d.receivedBytes)} из ${formatBytes(d.totalBytes)}`}
            </span>
          ) : (
            d.receivedBytes > 0 && <span>{formatBytes(d.receivedBytes)}</span>
          ))}
        {running && d.speedBps > 0 && <span>{formatBytes(d.speedBps)}/с</span>}
        {eta && <span>осталось {eta}</span>}
        {d.phase && d.state !== 'done' && d.state !== 'error' && <span className="text-fg-muted">{d.phase}</span>}
      </div>

      {d.state === 'error' && d.error && (
        <div className="mt-1.5 text-[12.5px] break-words text-danger">
          {/[.!?]$/.test(d.error.trim()) ? d.error.trim() : `${d.error.trim()}.`}{' '}
          <span className="text-fg-muted">«Повторить» продолжит загрузку с места остановки.</span>
        </div>
      )}
    </li>
  )
}
