import { Boxes, FolderOpen, RefreshCw, Search, SlidersHorizontal, Trash, X } from 'lucide-react'
import { useMemo, useState } from 'react'
import { DEFAULT_LOAD_CONFIG, deepMerge, type LoadConfig } from '@shared/config'
import type { LocalModel } from '@shared/types'
import { Button, IconButton } from '@/components/ui/Button'
import { Field, NumberInput, Section, Select } from '@/components/ui/Field'
import { ConfirmModal, Modal } from '@/components/ui/Modal'
import { EmptyState, InlineError, PageHeader, Tag } from '@/components/ui/Page'
import { LoadSettingsForm } from '@/components/settings/LoadSettings'
import { call } from '@/lib/api'
import { useSettingsLoaded } from '@/lib/ensure'
import { cn, formatBytes } from '@/lib/format'
import { MEMORY_PROFILES } from '@/lib/labels'
import { dirOf, formatInt, friendlyError, plural } from '@/lib/text'
import { useEngine, useModels, useSettings } from '@/store/app'
import { useUi } from '@/store/ui'

// Узкое окно: столбец «Архитектура» прячется и переезжает в строку меток под названием.
const GRID =
  'grid grid-cols-[minmax(0,1fr)_68px_104px_84px_84px_184px] xl:grid-cols-[minmax(0,1fr)_68px_104px_84px_116px_84px_184px] items-center gap-x-3'

/** Настройки загрузки модели: общие по умолчанию + сохранённые для этой модели. */
function effectiveLoad(modelId: string): LoadConfig {
  const s = useSettings.getState().settings
  if (!s) return DEFAULT_LOAD_CONFIG
  return deepMerge(s.defaultLoad, s.perModelLoad[modelId])
}

const isPlain = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** Глубокая разница: только поля, отличающиеся от base (массивы сравниваются целиком). */
function diffConfig(base: unknown, value: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (!isPlain(base) || !isPlain(value)) return out
  for (const [k, v] of Object.entries(value)) {
    const b = base[k]
    if (isPlain(b) && isPlain(v)) {
      const d = diffConfig(b, v)
      if (Object.keys(d).length) out[k] = d
    } else if (JSON.stringify(b) !== JSON.stringify(v)) {
      out[k] = v
    }
  }
  return out
}

function groupLabel(m: LocalModel): string {
  return [m.publisher, m.repo].filter(Boolean).join('/') || 'Без папки автора'
}

function matches(m: LocalModel, q: string): boolean {
  if (!q) return true
  const hay = [m.name, m.publisher, m.repo, m.quant, m.paramsLabel, m.arch?.arch, m.format].join(' ').toLowerCase()
  return q
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((part) => hay.includes(part))
}

export function ModelsPage(): React.JSX.Element {
  const { settings, error: settingsError, reload: reloadSettings } = useSettingsLoaded()
  const models = useModels((s) => s.models)
  const loading = useModels((s) => s.loading)
  const status = useEngine((s) => s.status)
  const setPage = useUi((s) => s.setPage)

  const [query, setQuery] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [editing, setEditing] = useState<LocalModel | null>(null)
  const [deleting, setDeleting] = useState<LocalModel | null>(null)

  const refresh = async (): Promise<void> => {
    setError(null)
    try {
      await useModels.getState().refresh(true)
    } catch (e) {
      setError(`Не удалось прочитать папку моделей: ${friendlyError(e)}`)
    }
  }

  const changeFolder = async (): Promise<void> => {
    setError(null)
    try {
      const dir = await call('app:pickFolder', 'Папка с моделями')
      if (!dir) return
      await useSettings.getState().update({ modelsDir: dir })
      await useModels.getState().refresh(true)
    } catch (e) {
      setError(`Не удалось сменить папку: ${friendlyError(e)}`)
    }
  }

  const openPath = (p: string): void => {
    call('app:openPath', p).catch((e: unknown) => setError(`Не удалось открыть папку: ${friendlyError(e)}`))
  }

  const loadModel = (m: LocalModel): void => {
    const engine = useEngine.getState()
    engine.setSelected(m.id)
    engine.setDraftLoad(effectiveLoad(m.id))
    setPage('chat')
  }

  const groups = useMemo(() => {
    const map = new Map<string, LocalModel[]>()
    for (const m of models) {
      if (!matches(m, query.trim())) continue
      const key = groupLabel(m)
      const list = map.get(key) ?? []
      list.push(m)
      map.set(key, list)
    }
    return [...map.entries()]
      .sort(([a], [b]) => a.localeCompare(b, 'ru', { sensitivity: 'base' }))
      .map(([key, list]) => ({ key, list: list.sort((a, b) => a.name.localeCompare(b.name, 'ru')) }))
  }, [models, query])

  const totalBytes = models.reduce((s, m) => s + m.sizeBytes, 0)
  const modelsDir = settings?.modelsDir ?? ''

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PageHeader title="Мои модели">
        <label className="relative w-[280px] min-w-0">
          <Search size={14} className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-fg-faint" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setQuery('')
            }}
            placeholder="Найти среди моделей"
            aria-label="Найти среди моделей"
            className="h-[30px] w-full rounded-[var(--radius-ctl)] border border-line bg-bg pr-7 pl-8 text-[13px] text-fg outline-none placeholder:text-fg-faint focus:border-accent"
          />
          {query && (
            <button
              aria-label="Очистить поиск"
              title="Очистить поиск"
              onClick={() => setQuery('')}
              className="absolute top-1/2 right-1.5 grid h-5 w-5 -translate-y-1/2 place-items-center rounded text-fg-faint hover:text-fg"
            >
              <X size={13} />
            </button>
          )}
        </label>
        <Button
          size="sm"
          onClick={() => void refresh()}
          disabled={loading}
          icon={<RefreshCw size={13} className={loading ? 'animate-spin' : undefined} />}
        >
          Обновить
        </Button>
      </PageHeader>

      <div className="flex shrink-0 items-center gap-3 border-b border-line px-6 py-2 text-[13px]">
        <span className="shrink-0 text-fg-muted">Папка моделей</span>
        <span className="min-w-0 truncate font-mono text-[12.5px] text-fg" title={modelsDir}>
          {modelsDir || '—'}
        </span>
        <Button size="sm" variant="ghost" onClick={() => void changeFolder()} disabled={!settings}>
          Изменить папку
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => openPath(modelsDir)}
          disabled={!modelsDir}
          icon={<FolderOpen size={13} />}
        >
          Открыть папку
        </Button>
        <span className="tabular ml-auto shrink-0 text-fg-faint">
          {models.length > 0 &&
            `${models.length} ${plural(models.length, ['модель', 'модели', 'моделей'])}, ${formatBytes(totalBytes)}`}
        </span>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {(error || settingsError) && (
          <div className="px-6 pt-3">
            {error && <InlineError message={error} onRetry={() => void refresh()} />}
            {settingsError && (
              <InlineError
                className={error ? 'mt-2' : undefined}
                message={`Настройки не загрузились: ${settingsError}`}
                onRetry={reloadSettings}
              />
            )}
          </div>
        )}

        {models.length === 0 ? (
          loading ? (
            <div className="px-6 py-10 text-[13px] text-fg-muted">Ищем модели в папке…</div>
          ) : (
            <EmptyState
              icon={<Boxes size={28} strokeWidth={1.5} />}
              title="Моделей пока нет"
              actions={
                <>
                  <Button variant="primary" icon={<Search size={14} />} onClick={() => setPage('discover')}>
                    Найти модели
                  </Button>
                  {modelsDir && (
                    <Button icon={<FolderOpen size={14} />} onClick={() => openPath(modelsDir)}>
                      Открыть папку
                    </Button>
                  )}
                </>
              }
            >
              Скачайте модель в разделе «Поиск» или положите файлы в папку моделей
              {modelsDir && (
                <>
                  {' '}
                  <span className="font-mono text-[12px] break-all text-fg">{modelsDir}</span>
                </>
              )}
              . Раскладка как в LM Studio: автор, затем репозиторий, внутри файлы .gguf или папка EXL3.
            </EmptyState>
          )
        ) : groups.length === 0 ? (
          <EmptyState
            title="Ничего не найдено"
            actions={
              <Button size="sm" onClick={() => setQuery('')}>
                Сбросить поиск
              </Button>
            }
          >
            Нет моделей, подходящих под «{query.trim()}».
          </EmptyState>
        ) : (
          <div className="pb-6">
            <div
              className={cn(
                GRID,
                'sticky top-0 z-10 border-b border-line bg-bg px-6 py-2 text-[12px] text-fg-faint'
              )}
            >
              <span>Модель</span>
              <span>Параметры</span>
              <span>Квант</span>
              <span className="text-right">Размер</span>
              <span className="hidden xl:block">Архитектура</span>
              <span className="text-right">Контекст</span>
              <span />
            </div>
            {groups.map((g) => (
              <section key={g.key}>
                <h2 className="truncate border-b border-line px-6 pt-4 pb-1.5 text-[12.5px] font-medium text-fg-muted">
                  {g.key}
                </h2>
                {g.list.map((m) => (
                  <ModelRow
                    key={m.id}
                    model={m}
                    loaded={status.modelId === m.id && status.state === 'ready'}
                    loadingNow={status.modelId === m.id && (status.state === 'loading' || status.state === 'starting')}
                    customLoad={Boolean(settings?.perModelLoad[m.id])}
                    onLoad={() => loadModel(m)}
                    onSettings={() => setEditing(m)}
                    onReveal={() => openPath(m.format === 'gguf' ? dirOf(m.path) : m.path)}
                    onDelete={() => setDeleting(m)}
                  />
                ))}
              </section>
            ))}
          </div>
        )}
      </div>

      {editing && settings && (
        <PerModelSettingsModal key={editing.id} model={editing} onClose={() => setEditing(null)} />
      )}

      <ConfirmModal
        open={deleting !== null}
        onOpenChange={(v) => {
          if (!v) setDeleting(null)
        }}
        title="Удалить модель?"
        confirmLabel="Удалить"
        danger
        onConfirm={async () => {
          if (!deleting) return
          await call('models:delete', deleting.id)
          await useModels
            .getState()
            .refresh()
            .catch(() => undefined)
        }}
      >
        {deleting && (
          <>
            <span className="text-fg">{deleting.name}</span> будет удалена с диска вместе с файлами (
            {formatBytes(deleting.sizeBytes)}). Отменить это нельзя, но модель можно скачать заново.
          </>
        )}
      </ConfirmModal>
    </div>
  )
}

function ModelRow({
  model: m,
  loaded,
  loadingNow,
  customLoad,
  onLoad,
  onSettings,
  onReveal,
  onDelete
}: {
  model: LocalModel
  loaded: boolean
  loadingNow: boolean
  customLoad: boolean
  onLoad: () => void
  onSettings: () => void
  onReveal: () => void
  onDelete: () => void
}): React.JSX.Element {
  const quant = m.quant || (m.bpw ? `${m.bpw} bpw` : '')
  const ctx = m.arch?.contextLengthMax
  const moeTitle =
    m.arch && m.arch.nExperts > 0
      ? `Mixture of Experts: ${m.arch.nExperts} экспертов, активно ${m.arch.nExpertsUsed}`
      : 'Mixture of Experts'
  return (
    <div className={cn(GRID, 'border-b border-line px-6 py-2 transition-colors hover:bg-panel/70')}>
      <div className="min-w-0">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-[13.5px] text-fg" title={m.path}>
            {m.name}
          </span>
          {loaded && <Tag tone="ok">Загружена</Tag>}
          {loadingNow && <Tag tone="warn">Загружается</Tag>}
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-1">
          <Tag>{m.format === 'gguf' ? 'GGUF' : 'EXL3'}</Tag>
          {m.vision && (
            <Tag tone="info" title={m.mmprojPath ? `Проектор: ${m.mmprojPath}` : 'Модель понимает изображения'}>
              Vision
            </Tag>
          )}
          {m.isMoe && <Tag title={moeTitle}>MoE</Tag>}
          {m.isEmbedding && <Tag title="Модель для поиска по документам, не для чата">Эмбеддинги</Tag>}
          {m.arch?.arch && (
            <Tag className="xl:hidden" title="Архитектура">
              {m.arch.arch}
            </Tag>
          )}
          {customLoad && (
            <Tag tone="accent" title="Для этой модели сохранены свои настройки загрузки">
              Свои настройки
            </Tag>
          )}
        </div>
      </div>
      <span className="tabular truncate text-[13px] text-fg-muted">{m.paramsLabel || '—'}</span>
      <span className="truncate font-mono text-[12px] text-fg-muted" title={quant}>
        {quant || '—'}
      </span>
      <span className="tabular text-right text-[13px] text-fg-muted">{formatBytes(m.sizeBytes)}</span>
      <span className="hidden truncate text-[13px] text-fg-muted xl:block" title={m.arch?.arch}>
        {m.arch?.arch || '—'}
      </span>
      <span className="tabular text-right text-[13px] text-fg-muted">{ctx ? formatInt(ctx) : '—'}</span>
      <div className="flex items-center justify-end gap-0.5">
        <Button
          size="sm"
          className="mr-1"
          onClick={onLoad}
          disabled={Boolean(m.error) || m.isEmbedding}
          title={
            m.isEmbedding
              ? 'Это модель эмбеддингов: она превращает текст в векторы и не умеет вести диалог.'
              : 'Открыть в чате с настройками загрузки этой модели'
          }
        >
          Загрузить
        </Button>
        <IconButton label="Настройки по умолчанию" onClick={onSettings}>
          <SlidersHorizontal size={15} />
        </IconButton>
        <IconButton label="Показать в папке" onClick={onReveal}>
          <FolderOpen size={15} />
        </IconButton>
        <IconButton label="Удалить" onClick={onDelete} className="hover:text-danger!">
          <Trash size={15} />
        </IconButton>
      </div>
      {m.error && (
        <div className="col-span-full mt-1 text-[12px] break-words text-danger">Не удалось прочитать модель: {m.error}</div>
      )}
    </div>
  )
}

function PerModelSettingsModal({ model, onClose }: { model: LocalModel; onClose: () => void }): React.JSX.Element {
  const settings = useSettings((s) => s.settings)
  const [value, setValue] = useState<LoadConfig>(() => effectiveLoad(model.id))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const hasCustom = Boolean(settings?.perModelLoad[model.id])

  const apply = async (load: Partial<LoadConfig> | null): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const next = await call('settings:setPerModelLoad', model.id, load)
      useSettings.setState({ settings: next })
      onClose()
    } catch (e) {
      setError(friendlyError(e))
      setBusy(false)
    }
  }

  const save = (): void => {
    if (!settings) return
    const diff = diffConfig(settings.defaultLoad, value) as Partial<LoadConfig>
    void apply(Object.keys(diff).length ? diff : null)
  }

  const profile = MEMORY_PROFILES.find((p) => p.value === value.memory.profile)

  return (
    <Modal
      open
      onOpenChange={(v) => {
        if (!v && !busy) onClose()
      }}
      size="lg"
      title="Настройки загрузки по умолчанию"
      description={
        <>
          Для модели <span className="text-fg">{model.name}</span>. Они подставляются, когда вы выбираете эту модель;
          остальные модели берут общие настройки.
        </>
      }
      bodyClassName="py-1"
      footerStart={
        <Button
          variant="ghost"
          disabled={busy || !hasCustom}
          onClick={() => void apply(null)}
          title="Удалить сохранённые настройки этой модели и вернуться к общим"
        >
          Сбросить
        </Button>
      }
      footer={
        <>
          {error && <span className="mr-2 max-w-[300px] truncate text-[12.5px] text-danger" title={error}>{error}</span>}
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Отмена
          </Button>
          <Button variant="primary" onClick={save} disabled={busy || !settings}>
            Сохранить
          </Button>
        </>
      }
    >
      <Section title="Память">
        <Field label="Профиль памяти" hint={profile?.description}>
          <Select
            label="Профиль памяти"
            value={value.memory.profile}
            onChange={(p) => setValue({ ...value, memory: { ...value.memory, profile: p } })}
            options={MEMORY_PROFILES.map((p) => ({ value: p.value, label: p.label }))}
          />
        </Field>
        <Field label="Запас VRAM, МиБ" hint="Сколько видеопамяти оставить свободной для системы и других программ.">
          <NumberInput
            value={value.memory.vramReserveMiB}
            onChange={(v) => setValue({ ...value, memory: { ...value.memory, vramReserveMiB: Math.round(v) } })}
            min={0}
            max={16384}
            step={128}
          />
        </Field>
      </Section>
      <LoadSettingsForm model={model} value={value} onChange={setValue} />
    </Modal>
  )
}
