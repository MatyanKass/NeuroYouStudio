import { ArrowDown, Check, Copy, RefreshCw, Search } from 'lucide-react'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { EngineId } from '@shared/config'
import type { EngineState, RuntimeDescriptor, TaskProgress } from '@shared/types'
import { Button } from '@/components/ui/Button'
import { ConfirmModal } from '@/components/ui/Modal'
import { InlineError, PageHeader, ProgressBar, Tag } from '@/components/ui/Page'
import { call } from '@/lib/api'
import { useHardwareInfo, useSettingsLoaded } from '@/lib/ensure'
import { cn, formatBytes, formatMiB } from '@/lib/format'
import { ENGINE_LABEL } from '@/lib/labels'
import { effectiveRuntime } from '@/lib/runtimes'
import { friendlyError } from '@/lib/text'
import { useEngine, useHardware, useRuntimes, useSettings } from '@/store/app'

const ENGINES: Array<{ id: EngineId; when: string }> = [
  {
    id: 'llamacpp',
    when: 'GGUF-модели, которые целиком помещаются в видеопамять.'
  },
  {
    id: 'ikllama',
    when: 'GGUF-модели, которые не помещаются в VRAM, и MoE-модели с экспертами в RAM: быстрее считает слои на процессоре.'
  },
  {
    id: 'exl3',
    when: 'Модели формата EXL3. Самый быстрый вариант, но модель должна целиком помещаться в VRAM.'
  }
]

const ENGINE_STATE: Record<EngineState, string> = {
  idle: 'не запущен',
  starting: 'запускается',
  loading: 'загружает модель',
  ready: 'работает',
  stopping: 'останавливается',
  error: 'ошибка'
}

export function RuntimesPage(): React.JSX.Element {
  const runtimes = useRuntimes((s) => s.runtimes)
  const progress = useRuntimes((s) => s.progress)
  const { settings } = useSettingsLoaded()
  const [listError, setListError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [removing, setRemoving] = useState<RuntimeDescriptor | null>(null)

  const refresh = (): void => {
    setRefreshing(true)
    setListError(null)
    useRuntimes
      .getState()
      .refresh()
      .catch((e: unknown) => setListError(friendlyError(e)))
      .finally(() => setRefreshing(false))
  }

  useEffect(() => {
    let alive = true
    useRuntimes
      .getState()
      .refresh()
      .catch((e: unknown) => alive && setListError(friendlyError(e)))
    return () => {
      alive = false
    }
  }, [])

  const install = (r: RuntimeDescriptor): void => {
    setActionError(null)
    // Сбрасываем старую ошибку, чтобы сразу показать новый прогресс.
    useRuntimes.setState((s) => {
      const next = { ...s.progress }
      delete next[r.id]
      return { progress: next }
    })
    call('runtimes:install', r.id).catch((e: unknown) =>
      setActionError(`Не удалось установить «${r.title}»: ${friendlyError(e)}`)
    )
  }

  const select = (r: RuntimeDescriptor): void => {
    setActionError(null)
    call('runtimes:select', r.id)
      .then((s) => useSettings.setState({ settings: s }))
      .catch((e: unknown) => setActionError(`Не удалось выбрать «${r.title}»: ${friendlyError(e)}`))
  }

  const byEngine = useMemo(() => {
    const map = new Map<EngineId, RuntimeDescriptor[]>()
    for (const r of runtimes) {
      const list = map.get(r.engine) ?? []
      list.push(r)
      map.set(r.engine, list)
    }
    return map
  }, [runtimes])

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PageHeader title="Движки">
        <Button
          size="sm"
          variant="ghost"
          onClick={refresh}
          disabled={refreshing}
          icon={<RefreshCw size={13} className={refreshing ? 'animate-spin' : undefined} />}
        >
          Обновить
        </Button>
      </PageHeader>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-[980px] px-6 pt-5 pb-10">
          <section>
            <h2 className="text-[14px] font-semibold text-fg">Какой движок запускается</h2>
            <p className="mt-1 text-[13px] text-fg-muted">
              По умолчанию движок выбирается автоматически по модели. Его можно задать вручную в настройках загрузки
              модели.
            </p>
            <dl className="mt-3 border-t border-line text-[13px]">
              {ENGINES.map((e) => (
                <div key={e.id} className="grid grid-cols-[140px_minmax(0,1fr)] gap-3 border-b border-line py-2">
                  <dt className="font-medium text-fg">{ENGINE_LABEL[e.id]}</dt>
                  <dd className="text-fg-muted">{e.when}</dd>
                </div>
              ))}
            </dl>
          </section>

          <HardwareSection />

          <section className="mt-8">
            <h2 className="text-[14px] font-semibold text-fg">Сборки</h2>
            {actionError && <InlineError className="mt-3" message={actionError} />}
            {listError ? (
              <InlineError className="mt-3" message={`Список сборок недоступен: ${listError}`} onRetry={refresh} />
            ) : runtimes.length === 0 ? (
              <p className="mt-2 text-[13px] text-fg-muted">Список сборок загружается…</p>
            ) : (
              ENGINES.map((e) => (
                <EngineGroup
                  key={e.id}
                  engine={e.id}
                  runtimes={byEngine.get(e.id) ?? []}
                  selectedId={settings?.selectedRuntimes[e.id]}
                  progress={progress}
                  onInstall={install}
                  onSelect={select}
                  onRemove={setRemoving}
                />
              ))
            )}
          </section>

          <LogSection />
        </div>
      </div>

      <ConfirmModal
        open={removing !== null}
        onOpenChange={(v) => {
          if (!v) setRemoving(null)
        }}
        title="Удалить сборку?"
        confirmLabel="Удалить"
        danger
        onConfirm={async () => {
          if (!removing) return
          await call('runtimes:remove', removing.id)
          await useRuntimes
            .getState()
            .refresh()
            .catch(() => undefined)
        }}
      >
        {removing && (
          <>
            Файлы <span className="text-fg">{removing.title}</span> будут удалены с диска. Сборку можно установить
            заново в любой момент.
          </>
        )}
      </ConfirmModal>
    </div>
  )
}

function HardwareSection(): React.JSX.Element {
  const { info, error, reload } = useHardwareInfo()
  const live = useHardware((s) => s.live)
  const yes = (v: boolean): React.JSX.Element =>
    v ? <span className="text-ok">есть</span> : <span className="text-fg-faint">нет</span>

  const rows: Array<[string, React.ReactNode]> = []
  if (info) {
    if (info.gpus.length === 0) {
      rows.push(['Видеокарта', <span className="text-warn">NVIDIA не найдена — доступна только работа на процессоре</span>])
    }
    for (const g of info.gpus) {
      const suffix = info.gpus.length > 1 ? ` ${g.index + 1}` : ''
      rows.push([`Видеокарта${suffix}`, g.name])
      rows.push([
        'Видеопамять',
        <span className="tabular">
          {formatMiB(g.vramTotalMiB)}
          <span className="text-fg-faint">
            {' '}
            (свободно {formatMiB(info.gpus.length === 1 && live ? live.vramTotalMiB - live.vramUsedMiB : g.vramFreeMiB)})
          </span>
        </span>
      ])
      rows.push([
        'Драйвер',
        <span className="tabular">
          {g.driverVersion || '—'}
          {info.cudaVersion && <span className="text-fg-faint">, поддерживает CUDA до {info.cudaVersion}</span>}
        </span>
      ])
      rows.push(['Compute capability', <span className="tabular">{g.computeCap || '—'}</span>])
    }
    rows.push([
      'Процессор',
      <span>
        {info.cpuName || '—'}
        {info.cpuCores > 0 && (
          <span className="tabular text-fg-faint">
            , {info.cpuCores} ядер, {info.cpuThreads} потоков
          </span>
        )}
      </span>
    ])
    rows.push([
      'Инструкции',
      <span>
        AVX2 {yes(info.avx2)}, AVX-512 {yes(info.avx512)}
      </span>
    ])
    rows.push(['Оперативная память', <span className="tabular">{formatMiB(info.ramTotalMiB)}</span>])
  }

  return (
    <section className="mt-8">
      <h2 className="text-[14px] font-semibold text-fg">Ваше железо</h2>
      {error ? (
        <InlineError className="mt-3" message={`Не удалось определить железо: ${error}`} onRetry={reload} />
      ) : !info ? (
        <p className="mt-2 text-[13px] text-fg-muted">Определяем видеокарту и процессор…</p>
      ) : (
        <dl className="mt-3 grid grid-cols-1 border-t border-line text-[13px] min-[1180px]:grid-cols-2 min-[1180px]:gap-x-8">
          {rows.map(([k, v], i) => (
            <div key={i} className="grid grid-cols-[150px_minmax(0,1fr)] gap-3 border-b border-line py-1.5">
              <dt className="text-fg-muted">{k}</dt>
              <dd className="min-w-0 break-words text-fg">{v}</dd>
            </div>
          ))}
        </dl>
      )}
    </section>
  )
}

function EngineGroup({
  engine,
  runtimes,
  selectedId,
  progress,
  onInstall,
  onSelect,
  onRemove
}: {
  engine: EngineId
  runtimes: RuntimeDescriptor[]
  selectedId: string | undefined
  progress: Record<string, TaskProgress>
  onInstall: (r: RuntimeDescriptor) => void
  onSelect: (r: RuntimeDescriptor) => void
  onRemove: (r: RuntimeDescriptor) => void
}): React.JSX.Element {
  const active = effectiveRuntime(engine, runtimes, selectedId)
  return (
    <div className="mt-5">
      <h3 className="border-b border-line pb-1.5 text-[13px] font-semibold text-fg">{ENGINE_LABEL[engine]}</h3>
      {runtimes.length === 0 ? (
        <p className="border-b border-line py-3 text-[13px] text-fg-muted">Сборок для этого движка пока нет.</p>
      ) : (
        runtimes.map((r) => (
          <RuntimeRow
            key={r.id}
            runtime={r}
            selected={active?.runtime.id === r.id ? (active.auto ? 'auto' : 'manual') : null}
            progress={progress[r.id]}
            onInstall={() => onInstall(r)}
            onSelect={() => onSelect(r)}
            onRemove={() => onRemove(r)}
          />
        ))
      )}
    </div>
  )
}

function RuntimeRow({
  runtime: r,
  selected,
  progress: p,
  onInstall,
  onSelect,
  onRemove
}: {
  runtime: RuntimeDescriptor
  /** manual — выбрана вручную; auto — не выбрана, но запустится как лучшая из установленных. */
  selected: 'manual' | 'auto' | null
  progress: TaskProgress | undefined
  onInstall: () => void
  onSelect: () => void
  onRemove: () => void
}): React.JSX.Element {
  const installing = Boolean(p && !p.done && !p.error)
  const failed = Boolean(p?.error)
  const pct = p && p.totalBytes > 0 ? p.receivedBytes / p.totalBytes : null

  return (
    <div className="border-b border-line py-3">
      <div className="flex items-start gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[13.5px] font-medium text-fg">{r.title}</span>
            {selected === 'manual' && <Tag tone="accent">Выбран</Tag>}
            {selected === 'auto' && (
              <Tag tone="accent" title="Вручную ничего не выбрано — запускается лучшая из установленных сборок">
                Выбран автоматически
              </Tag>
            )}
            {r.installed && <Tag tone="ok">Установлен</Tag>}
            {r.recommended && r.compatible && <Tag tone="info">Рекомендуется</Tag>}
            {!r.compatible && <Tag tone="danger">Не подходит</Tag>}
          </div>
          {!r.compatible && r.incompatibleReason && (
            <p className="mt-0.5 text-[12.5px] text-danger">{r.incompatibleReason}</p>
          )}
          <p className="mt-0.5 text-[12.5px] text-fg-muted">{r.description}</p>
          <div className="mt-1 flex flex-wrap items-center gap-x-4 text-[12px] text-fg-faint">
            <span className="font-mono text-[11.5px]">{r.version}</span>
            <span>{r.variant}</span>
            {r.downloadBytes > 0 && <span className="tabular">Загрузка {formatBytes(r.downloadBytes)}</span>}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5 pt-0.5">
          {r.installed ? (
            <>
              {selected !== 'manual' && (
                <Button size="sm" onClick={onSelect} disabled={!r.compatible} title={r.incompatibleReason}>
                  Выбрать
                </Button>
              )}
              <Button size="sm" variant="ghost" className="hover:text-danger!" onClick={onRemove}>
                Удалить
              </Button>
            </>
          ) : (
            <Button
              size="sm"
              variant={r.recommended && r.compatible ? 'primary' : 'secondary'}
              onClick={onInstall}
              disabled={installing}
            >
              {installing ? 'Устанавливается…' : failed ? 'Повторить' : 'Установить'}
            </Button>
          )}
        </div>
      </div>

      {installing && p && (
        <div className="mt-2">
          <ProgressBar value={pct} label={`Установка ${r.title}`} />
          <div className="tabular mt-1 flex items-center gap-4 text-[12px] text-fg-muted">
            <span>{p.phase || 'Подготовка'}</span>
            {p.totalBytes > 0 && (
              <span className="text-fg-faint">
                {formatBytes(p.receivedBytes)} из {formatBytes(p.totalBytes)}
              </span>
            )}
            {pct !== null && <span className="ml-auto">{Math.floor(pct * 100)}%</span>}
          </div>
        </div>
      )}
      {failed && p?.error && (
        <InlineError className="mt-2" message={`Установка не удалась: ${p.error}`} />
      )}
    </div>
  )
}

const ERR_RE = /\b(error|failed|fatal|exception|ошибка|не удалось)\b/i
const WARN_RE = /\b(warn|warning|предупреждение)\b/i

function LogSection(): React.JSX.Element {
  const logs = useEngine((s) => s.logs)
  const status = useEngine((s) => s.status)
  const [filter, setFilter] = useState('')
  const [copied, setCopied] = useState(false)
  const [stuck, setStuck] = useState(true)
  const boxRef = useRef<HTMLDivElement>(null)

  const lines = useMemo(() => {
    const f = filter.trim().toLowerCase()
    return f ? logs.filter((l) => l.toLowerCase().includes(f)) : logs
  }, [logs, filter])

  useLayoutEffect(() => {
    const el = boxRef.current
    if (el && stuck) el.scrollTop = el.scrollHeight
  }, [lines, stuck])

  const copy = (): void => {
    navigator.clipboard
      .writeText(lines.join('\n'))
      .then(() => {
        setCopied(true)
        setTimeout(() => setCopied(false), 1500)
      })
      .catch(() => undefined)
  }

  return (
    <section className="mt-8">
      <div className="flex items-center gap-3">
        <h2 className="text-[14px] font-semibold text-fg">Лог движка</h2>
        <span className="text-[12.5px] text-fg-faint">
          {status.engine ? ENGINE_LABEL[status.engine] : 'Движок'} {ENGINE_STATE[status.state]}
        </span>
        <div className="ml-auto flex items-center gap-2">
          <label className="relative w-[220px]">
            <Search size={13} className="pointer-events-none absolute top-1/2 left-2 -translate-y-1/2 text-fg-faint" />
            <input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Фильтр строк"
              aria-label="Фильтр строк лога"
              className="h-7 w-full rounded-[var(--radius-ctl)] border border-line bg-bg pr-2 pl-7 text-[12.5px] text-fg outline-none placeholder:text-fg-faint focus:border-accent"
            />
          </label>
          <Button
            size="sm"
            variant="ghost"
            onClick={copy}
            disabled={lines.length === 0}
            icon={copied ? <Check size={13} /> : <Copy size={13} />}
          >
            {copied ? 'Скопировано' : 'Копировать лог'}
          </Button>
        </div>
      </div>
      <div className="relative mt-2">
        <div
          ref={boxRef}
          onScroll={(e) => {
            const el = e.currentTarget
            const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24
            if (atBottom !== stuck) setStuck(atBottom)
          }}
          className="h-[340px] overflow-auto rounded-[var(--radius-panel)] border border-line bg-panel px-3 py-2 font-mono text-[11.5px] leading-[1.55] [font-variant-ligatures:none]"
          role="log"
          aria-label="Лог движка"
        >
          {lines.length === 0 ? (
            <div className="py-1 font-sans text-[12.5px] text-fg-faint">
              {logs.length === 0
                ? 'Лог пуст. Загрузите модель — здесь появится вывод движка.'
                : 'Нет строк, подходящих под фильтр.'}
            </div>
          ) : (
            lines.map((l, i) => (
              <div
                key={i}
                className={cn(
                  'break-all whitespace-pre-wrap',
                  ERR_RE.test(l) ? 'text-danger' : WARN_RE.test(l) ? 'text-warn' : 'text-fg-muted'
                )}
              >
                {l}
              </div>
            ))
          )}
        </div>
        {!stuck && lines.length > 0 && (
          <Button
            size="sm"
            className="absolute right-3 bottom-3"
            icon={<ArrowDown size={13} />}
            onClick={() => setStuck(true)}
          >
            К концу лога
          </Button>
        )}
      </div>
    </section>
  )
}
