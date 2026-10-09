import { Check, Copy, ExternalLink, FolderOpen } from 'lucide-react'
import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import type { DeepPartial, EngineChoice } from '@shared/config'
import type { AppInfo, AppSettings } from '@shared/types'
import { Button } from '@/components/ui/Button'
import { FieldLabelContext, NumberInput, Select, Switch } from '@/components/ui/Field'
import { InlineError, PageHeader } from '@/components/ui/Page'
import { Segmented } from '@/components/ui/Segmented'
import { call } from '@/lib/api'
import { useSettingsLoaded } from '@/lib/ensure'
import { cn } from '@/lib/format'
import { ENGINE_LABEL, GUARDRAILS, MEMORY_PROFILES } from '@/lib/labels'
import { effectiveRuntime } from '@/lib/runtimes'
import { friendlyError } from '@/lib/text'
import { useModels, useRuntimes, useSettings } from '@/store/app'
import { useUi } from '@/store/ui'

const SECTIONS = [
  { id: 'appearance', title: 'Внешний вид' },
  { id: 'memory', title: 'Модели и память' },
  { id: 'engines', title: 'Движки' },
  { id: 'hf', title: 'Hugging Face' },
  { id: 'docs', title: 'Документы в чате' },
  { id: 'images', title: 'Изображения' },
  { id: 'diagnostics', title: 'Диагностика' },
  { id: 'about', title: 'О программе' }
] as const

type SectionId = (typeof SECTIONS)[number]['id']

export function SettingsPage(): React.JSX.Element {
  const { settings, error: loadError, reload } = useSettingsLoaded()
  const [saveError, setSaveError] = useState<string | null>(null)
  const [active, setActive] = useState<SectionId>('appearance')
  const scrollRef = useRef<HTMLDivElement>(null)

  const save = (patch: DeepPartial<AppSettings>): void => {
    setSaveError(null)
    useSettings
      .getState()
      .update(patch)
      .catch((e: unknown) => setSaveError(`Не удалось сохранить настройку: ${friendlyError(e)}`))
  }

  const onScroll = (): void => {
    const box = scrollRef.current
    if (!box) return
    if (box.scrollTop + box.clientHeight >= box.scrollHeight - 4) {
      setActive(SECTIONS[SECTIONS.length - 1]!.id)
      return
    }
    let current: SectionId = SECTIONS[0].id
    for (const s of SECTIONS) {
      const el = box.querySelector<HTMLElement>(`[data-section="${s.id}"]`)
      if (el && el.offsetTop - box.offsetTop - box.scrollTop <= 48) current = s.id
    }
    setActive(current)
  }

  const goTo = (id: SectionId): void => {
    const box = scrollRef.current
    const el = box?.querySelector<HTMLElement>(`[data-section="${id}"]`)
    if (!box || !el) return
    box.scrollTo({ top: el.offsetTop - box.offsetTop - 20, behavior: 'smooth' })
    setActive(id)
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PageHeader title="Настройки" />
      <div className="flex min-h-0 flex-1">
        <nav aria-label="Разделы настроек" className="w-[196px] shrink-0 border-r border-line px-2 py-3">
          {SECTIONS.map((s) => (
            <button
              key={s.id}
              onClick={() => goTo(s.id)}
              aria-current={active === s.id || undefined}
              className={cn(
                'block w-full rounded-[var(--radius-ctl)] px-2.5 py-1.5 text-left text-[13px] transition-colors',
                active === s.id ? 'bg-accent-soft text-accent-strong' : 'text-fg-muted hover:bg-panel hover:text-fg'
              )}
            >
              {s.title}
            </button>
          ))}
        </nav>

        <div ref={scrollRef} onScroll={onScroll} className="relative min-w-0 flex-1 overflow-y-auto">
          {(saveError || loadError) && (
            <div className="sticky top-0 z-10 bg-bg px-8 pt-3">
              {loadError && <InlineError message={`Настройки не загрузились: ${loadError}`} onRetry={reload} />}
              {saveError && <InlineError message={saveError} />}
            </div>
          )}
          {!settings ? (
            !loadError && <p className="px-8 py-6 text-[13px] text-fg-muted">Загружаем настройки…</p>
          ) : (
            <div className="max-w-[760px] space-y-10 px-8 pt-6 pb-16">
              <AppearanceSection s={settings} save={save} />
              <MemorySection s={settings} save={save} />
              <EnginesSection s={settings} save={save} />
              <HfSection s={settings} />
              <DocsSection s={settings} save={save} />
              <ImagesSection s={settings} save={save} />
              <DiagnosticsSection />
              <AboutSection modelsDir={settings.modelsDir} />
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

type SectionProps = { s: AppSettings; save: (patch: DeepPartial<AppSettings>) => void }

function Group({ id, title, children }: { id: SectionId; title: string; children: ReactNode }): React.JSX.Element {
  return (
    <section data-section={id} aria-labelledby={`settings-${id}`}>
      <h2 id={`settings-${id}`} className="text-[15px] font-semibold text-fg">
        {title}
      </h2>
      <div className="mt-2 border-t border-line">{children}</div>
    </section>
  )
}

function Row({
  label,
  description,
  children,
  stacked
}: {
  label: ReactNode
  description?: ReactNode
  children: ReactNode
  stacked?: boolean
}): React.JSX.Element {
  const labelId = useId()
  return (
    <div
      className={cn(
        'border-b border-line py-3',
        stacked ? 'flex flex-col gap-2.5' : 'flex items-center justify-between gap-6'
      )}
    >
      <div className="min-w-0">
        <div id={labelId} className="text-[13.5px] text-fg">
          {label}
        </div>
        {description && <div className="mt-0.5 text-[12.5px] leading-relaxed text-fg-muted">{description}</div>}
      </div>
      <div className={cn(stacked ? 'min-w-0' : 'flex shrink-0 items-center gap-2')}>
        <FieldLabelContext.Provider value={labelId}>{children}</FieldLabelContext.Provider>
      </div>
    </div>
  )
}

function Unit({ children }: { children: ReactNode }): React.JSX.Element {
  return <span className="text-[12.5px] text-fg-faint">{children}</span>
}

function RadioList<T extends string>({
  name,
  value,
  onChange,
  options
}: {
  name: string
  value: T
  onChange: (v: T) => void
  options: Array<{ value: T; label: string; description: string }>
}): React.JSX.Element {
  return (
    <div role="radiogroup" className="-mx-2 flex flex-col">
      {options.map((o) => (
        <label
          key={o.value}
          className={cn(
            'flex cursor-pointer items-start gap-2.5 rounded-[var(--radius-ctl)] px-2 py-1.5 transition-colors',
            value === o.value ? 'bg-panel' : 'hover:bg-panel/60'
          )}
        >
          <input
            type="radio"
            name={name}
            checked={value === o.value}
            onChange={() => onChange(o.value)}
            className="mt-[3px] h-3.5 w-3.5 shrink-0 accent-[var(--color-accent)]"
          />
          <span className="min-w-0">
            <span className="block text-[13px] text-fg">{o.label}</span>
            <span className="block text-[12.5px] text-fg-muted">{o.description}</span>
          </span>
        </label>
      ))}
    </div>
  )
}

function AppearanceSection({ s, save }: SectionProps): React.JSX.Element {
  return (
    <Group id="appearance" title="Внешний вид">
      <Row label="Тема">
        <Segmented
          label="Тема"
          value={s.theme}
          onChange={(theme) => save({ theme })}
          options={[
            { value: 'dark', label: 'Тёмная' },
            { value: 'light', label: 'Светлая' },
            { value: 'auto', label: 'Как в системе' }
          ]}
        />
      </Row>
      <Row label="Размер шрифта">
        <Segmented
          label="Размер шрифта"
          value={s.fontSize}
          onChange={(fontSize) => save({ fontSize })}
          options={[
            { value: 'small', label: 'Мелкий' },
            { value: 'default', label: 'Обычный' },
            { value: 'large', label: 'Крупный' }
          ]}
        />
      </Row>
      <Row
        label="Раскрывать рассуждения по умолчанию"
        description="Показывать ход мыслей модели развёрнутым, а не свёрнутым в одну строку."
      >
        <Switch
          label="Раскрывать рассуждения по умолчанию"
          checked={s.expandReasoning}
          onChange={(expandReasoning) => save({ expandReasoning })}
        />
      </Row>
    </Group>
  )
}

function MemorySection({ s, save }: SectionProps): React.JSX.Element {
  const [error, setError] = useState<string | null>(null)
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
  return (
    <Group id="memory" title="Модели и память">
      <Row
        label="Папка моделей"
        description={
          <span className="font-mono text-[12px] break-all text-fg-muted" title={s.modelsDir}>
            {s.modelsDir}
          </span>
        }
      >
        <Button size="sm" onClick={() => void changeFolder()}>
          Изменить папку
        </Button>
        <Button
          size="sm"
          variant="ghost"
          icon={<FolderOpen size={13} />}
          onClick={() => void call('app:openPath', s.modelsDir).catch((e: unknown) => setError(friendlyError(e)))}
        >
          Открыть
        </Button>
      </Row>
      {error && <InlineError className="my-2" message={error} />}
      <Row
        label="Длина контекста по умолчанию"
        description="Сколько токенов диалога модель держит в памяти. Для каждой модели можно задать своё значение в «Моих моделях»."
      >
        <NumberInput
          value={s.defaultLoad.contextLength}
          onChange={(v) => save({ defaultLoad: { contextLength: Math.round(v) } })}
          min={512}
          max={1048576}
          step={1024}
          width="w-24"
        />
        <Unit>токенов</Unit>
      </Row>
      <Row
        label="Запас VRAM"
        description="Сколько видеопамяти оставлять свободной для системы, браузера и других программ."
      >
        <NumberInput
          value={s.defaultLoad.memory.vramReserveMiB}
          onChange={(v) => save({ defaultLoad: { memory: { vramReserveMiB: Math.round(v) } } })}
          min={0}
          max={16384}
          step={128}
        />
        <Unit>МиБ</Unit>
      </Row>
      <Row label="Профиль памяти по умолчанию" description="Как раскладывать части модели между VRAM и RAM." stacked>
        <RadioList
          name="memory-profile"
          value={s.defaultLoad.memory.profile}
          onChange={(profile) => save({ defaultLoad: { memory: { profile } } })}
          options={MEMORY_PROFILES}
        />
      </Row>
      <Row
        label="Защита от перегрузки"
        description="Проверка перед загрузкой модели: хватит ли памяти, чтобы компьютер не начал зависать."
        stacked
      >
        <RadioList
          name="guardrails"
          value={s.guardrails}
          onChange={(guardrails) => save({ guardrails })}
          options={GUARDRAILS}
        />
      </Row>
    </Group>
  )
}

function EnginesSection({ s, save }: SectionProps): React.JSX.Element {
  const setPage = useUi((u) => u.setPage)
  const runtimes = useRuntimes((r) => r.runtimes)
  const selected = (['llamacpp', 'ikllama', 'exl3'] as const).map((e) => ({
    engine: e,
    active: effectiveRuntime(e, runtimes, s.selectedRuntimes[e])
  }))
  return (
    <Group id="engines" title="Движки">
      <Row
        label="Движок для GGUF по умолчанию"
        description="«Авто»: llama.cpp, если модель целиком помещается в VRAM, иначе ik_llama.cpp — он быстрее, когда часть модели в RAM."
      >
        <Select<EngineChoice>
          label="Движок для GGUF по умолчанию"
          value={s.defaultEngineGguf}
          onChange={(defaultEngineGguf) => save({ defaultEngineGguf })}
          className="h-[30px] max-w-none"
          options={[
            { value: 'auto', label: 'Авто' },
            { value: 'llamacpp', label: 'llama.cpp' },
            { value: 'ikllama', label: 'ik_llama.cpp' }
          ]}
        />
      </Row>
      <Row
        label="Сборки движков"
        description={
          <span className="mt-1 grid grid-cols-[110px_minmax(0,1fr)] gap-x-3 gap-y-0.5">
            {selected.map(({ engine, active }) => (
              <span key={engine} className="contents">
                <span>{ENGINE_LABEL[engine]}</span>
                <span className={active ? 'text-fg' : 'text-fg-faint'}>
                  {active ? active.runtime.title : 'не установлена'}
                  {active?.auto && <span className="text-fg-faint">, выбрана автоматически</span>}
                </span>
              </span>
            ))}
          </span>
        }
      >
        <Button size="sm" onClick={() => setPage('runtimes')}>
          Открыть «Движки»
        </Button>
      </Row>
    </Group>
  )
}

function HfSection({ s }: { s: AppSettings }): React.JSX.Element {
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const apply = async (value: string | null): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      useSettings.setState({ settings: await call('settings:setHfToken', value) })
      setToken('')
    } catch (e) {
      setError(friendlyError(e))
    } finally {
      setBusy(false)
    }
  }

  const trimmed = token.trim()
  const looksWrong = trimmed.length > 0 && !trimmed.startsWith('hf_')

  return (
    <Group id="hf" title="Hugging Face">
      <Row
        label="Токен доступа"
        description="Нужен для закрытых моделей (Llama, Gemma и других) и снимает часть ограничений на скорость. Хранится зашифрованным на этом компьютере."
        stacked
      >
        {s.hasHfToken && (
          <div className="mb-1 flex items-center gap-3 text-[13px]">
            <span className="flex items-center gap-1.5 text-ok">
              <Check size={14} />
              Токен сохранён
            </span>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => void apply(null)}>
              Удалить токен
            </Button>
          </div>
        )}
        <form
          className="flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            if (trimmed) void apply(trimmed)
          }}
        >
          <input
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder={s.hasHfToken ? 'Новый токен, чтобы заменить сохранённый' : 'hf_…'}
            aria-label="Токен Hugging Face"
            autoComplete="off"
            spellCheck={false}
            className="h-[30px] w-[360px] max-w-full rounded-[var(--radius-ctl)] border border-line bg-bg px-2.5 font-mono text-[12.5px] text-fg outline-none placeholder:font-sans placeholder:text-fg-faint focus:border-accent"
          />
          <Button size="sm" variant="primary" type="submit" disabled={busy || !trimmed}>
            Сохранить
          </Button>
        </form>
        {looksWrong && (
          <div className="text-[12.5px] text-warn">Токены Hugging Face обычно начинаются с «hf_». Проверьте, что скопировали его целиком.</div>
        )}
        {error && <div className="text-[12.5px] text-danger">Не удалось сохранить токен: {error}</div>}
        <button
          type="button"
          onClick={() => void call('app:openExternal', 'https://huggingface.co/settings/tokens').catch(() => undefined)}
          className="flex w-fit items-center gap-1 text-[12.5px] text-info hover:underline"
        >
          Создать токен на huggingface.co
          <ExternalLink size={12} />
        </button>
      </Row>
    </Group>
  )
}

function DocsSection({ s, save }: SectionProps): React.JSX.Element {
  return (
    <Group id="docs" title="Документы в чате">
      <p className="border-b border-line py-3 text-[12.5px] leading-relaxed text-fg-muted">
        Если прикреплённые документы помещаются в контекст модели, они вставляются целиком. Иначе документ режется на
        фрагменты и в запрос подставляются самые подходящие к вопросу.
      </p>
      <Row label="Размер фрагмента" description="Длина одного фрагмента документа.">
        <NumberInput
          value={s.ragChunkSize}
          onChange={(v) => save({ ragChunkSize: Math.round(v) })}
          min={64}
          max={8192}
          step={64}
        />
        <Unit>токенов</Unit>
      </Row>
      <Row label="Перекрытие" description="Сколько токенов соседние фрагменты делят между собой, чтобы мысль не обрывалась на границе.">
        <NumberInput
          value={s.ragChunkOverlap}
          onChange={(v) => save({ ragChunkOverlap: Math.round(v) })}
          min={0}
          max={Math.max(0, Math.floor(s.ragChunkSize / 2))}
          step={16}
        />
        <Unit>токенов</Unit>
      </Row>
      <Row label="Сколько фрагментов подставлять" description="Больше фрагментов — полнее ответ, но меньше места для диалога.">
        <NumberInput value={s.ragTopK} onChange={(v) => save({ ragTopK: Math.round(v) })} min={1} max={50} />
      </Row>
    </Group>
  )
}

function ImagesSection({ s, save }: SectionProps): React.JSX.Element {
  return (
    <Group id="images" title="Изображения">
      <Row
        label="Максимальный размер стороны"
        description="Картинки крупнее уменьшаются перед отправкой модели: так быстрее и меньше расход контекста."
      >
        <NumberInput
          value={s.imageMaxDimension}
          onChange={(v) => save({ imageMaxDimension: Math.round(v) })}
          min={256}
          max={4096}
          step={128}
        />
        <Unit>пикселей</Unit>
      </Row>
    </Group>
  )
}

function DiagnosticsSection(): React.JSX.Element {
  const [state, setState] = useState<'idle' | 'busy' | 'copied'>('idle')
  const [error, setError] = useState<string | null>(null)

  const copyReport = async (): Promise<void> => {
    setState('busy')
    setError(null)
    try {
      const text = await call('app:diagnostics')
      await navigator.clipboard.writeText(text)
      setState('copied')
      setTimeout(() => setState('idle'), 2000)
    } catch (e) {
      setState('idle')
      setError(`Не удалось собрать отчёт: ${friendlyError(e)}`)
    }
  }

  const openLogs = async (): Promise<void> => {
    setError(null)
    try {
      const info = await call('app:info')
      await call('app:openPath', info.logsDir)
    } catch (e) {
      setError(`Не удалось открыть папку логов: ${friendlyError(e)}`)
    }
  }

  return (
    <Group id="diagnostics" title="Диагностика">
      <Row
        label="Отчёт для поддержки"
        description="Версии, железо, движки, список моделей и последние строки лога. Токен и переписка в отчёт не попадают. Вставьте его в сообщение об ошибке."
      >
        <Button
          size="sm"
          onClick={() => void copyReport()}
          disabled={state === 'busy'}
          icon={state === 'copied' ? <Check size={13} /> : <Copy size={13} />}
        >
          {state === 'copied' ? 'Скопировано' : 'Скопировать отчёт'}
        </Button>
      </Row>
      <Row label="Логи приложения" description="Файлы журналов движков и самого приложения.">
        <Button size="sm" icon={<FolderOpen size={13} />} onClick={() => void openLogs()}>
          Открыть папку логов
        </Button>
      </Row>
      {error && <InlineError className="my-2" message={error} />}
    </Group>
  )
}

function AboutSection({ modelsDir }: { modelsDir: string }): React.JSX.Element {
  const [info, setInfo] = useState<AppInfo | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [tick, setTick] = useState(0)

  useEffect(() => {
    let alive = true
    call('app:info')
      .then((i) => alive && setInfo(i))
      .catch((e: unknown) => alive && setError(friendlyError(e)))
    return () => {
      alive = false
    }
  }, [tick])

  const open = (p: string): void => {
    call('app:openPath', p).catch((e: unknown) => setError(friendlyError(e)))
  }

  const dirs: Array<[string, string]> = info
    ? [
        ['Настройки и чаты', info.userDataDir],
        ['Модели', modelsDir],
        ['Движки', info.runtimesDir],
        ['Логи', info.logsDir]
      ]
    : []

  return (
    <Group id="about" title="О программе">
      {error ? (
        <InlineError
          className="my-2"
          message={error}
          onRetry={() => {
            setError(null)
            setTick((n) => n + 1)
          }}
        />
      ) : !info ? (
        <p className="py-3 text-[13px] text-fg-muted">Загружаем сведения…</p>
      ) : (
        <>
          <Row label="NeuroYouStudio" description="Локальный запуск LLM на llama.cpp, ik_llama.cpp и ExLlamaV3.">
            <span className="tabular text-[13px] text-fg-muted">
              Версия {info.version}
              {!info.isPackaged && ', сборка для разработки'}
            </span>
          </Row>
          {dirs.map(([label, path]) => (
            <Row
              key={label}
              label={label}
              description={
                <span className="font-mono text-[12px] break-all" title={path}>
                  {path}
                </span>
              }
            >
              <Button size="sm" variant="ghost" icon={<FolderOpen size={13} />} onClick={() => open(path)}>
                Открыть
              </Button>
            </Row>
          ))}
        </>
      )}
    </Group>
  )
}
