import { ChevronDown, Eye, Loader2, Power, Search } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { LocalModel, MemoryComponentId } from '@shared/types'
import { useEngine, useHardware, useModels } from '@/store/app'
import { useUi } from '@/store/ui'
import { cn, formatBytes, formatMiB } from '@/lib/format'
import { Button } from '@/components/ui/Button'
import { MemoryBar } from '@/components/memory/MemoryBar'
import { engineName } from '@/components/memory/MemoryPanel'

function ModelPicker(): React.JSX.Element {
  const models = useModels((s) => s.models)
  const { selectedModelId, selectModel, status } = useEngine()
  const setPage = useUi((s) => s.setPage)
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const box = useRef<HTMLDivElement>(null)
  const selected = models.find((m) => m.id === selectedModelId)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [open])

  const list = useMemo(() => {
    const s = q.trim().toLowerCase()
    return models
      .filter((m) => !m.isEmbedding)
      .filter((m) => !s || `${m.name} ${m.repo} ${m.quant}`.toLowerCase().includes(s))
  }, [models, q])

  const pick = (m: LocalModel): void => {
    selectModel(m.id)
    setOpen(false)
  }

  return (
    <div ref={box} className="relative min-w-0">
      <button
        onClick={() => setOpen(!open)}
        className="flex h-9 max-w-[440px] min-w-[260px] items-center gap-2 rounded-[var(--radius-ctl)] border border-line-strong/70 bg-panel-2 px-3 text-left hover:border-line-strong"
        aria-expanded={open}
      >
        {selected ? (
          <span className="flex min-w-0 flex-1 items-baseline gap-2">
            <span className="truncate text-[13.5px] font-medium text-fg">{selected.name}</span>
            <span className="shrink-0 text-[12px] text-fg-faint">
              {selected.quant} {selected.format === 'exl3' ? 'EXL3' : ''}
            </span>
          </span>
        ) : (
          <span className="flex-1 text-[13.5px] text-fg-faint">Выберите модель для загрузки</span>
        )}
        {status.state === 'ready' && status.modelId === selectedModelId && (
          <span className="h-2 w-2 shrink-0 rounded-full bg-ok" title="Загружена" />
        )}
        <ChevronDown size={15} className="shrink-0 text-fg-faint" />
      </button>
      {open && (
        <div className="absolute top-[42px] left-0 z-30 w-[520px] overflow-hidden rounded-[var(--radius-panel)] border border-line-strong bg-panel shadow-[0_12px_40px_rgba(0,0,0,0.45)]">
          <div className="flex items-center gap-2 border-b border-line px-3 py-2 text-fg-faint">
            <Search size={14} />
            <input
              autoFocus
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Найти среди скачанных"
              className="w-full bg-transparent text-[13px] text-fg outline-none placeholder:text-fg-faint"
              onKeyDown={(e) => {
                if (e.key === 'Escape') setOpen(false)
                if (e.key === 'Enter' && list[0]) pick(list[0])
              }}
            />
          </div>
          <div className="max-h-[420px] overflow-y-auto py-1">
            {list.length === 0 && (
              <div className="px-3 py-4 text-[13px] text-fg-faint">
                {models.length ? 'Ничего не найдено' : 'Скачанных моделей нет.'}
                <button
                  className="ml-2 text-accent hover:underline"
                  onClick={() => {
                    setOpen(false)
                    setPage('discover')
                  }}
                >
                  Найти модели
                </button>
              </div>
            )}
            {list.map((m) => (
              <button
                key={m.id}
                onClick={() => pick(m)}
                className={cn(
                  'flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-panel-2',
                  m.id === selectedModelId && 'bg-raised'
                )}
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="truncate text-[13px] text-fg">{m.name}</span>
                    {m.vision && <Eye size={13} className="shrink-0 text-fg-faint" aria-label="Понимает изображения" />}
                  </div>
                  <div className="truncate text-[11.5px] text-fg-faint">
                    {m.publisher}/{m.repo}
                  </div>
                </div>
                <span className="shrink-0 text-[12px] text-fg-muted">{m.paramsLabel}</span>
                <span className="w-[72px] shrink-0 text-[12px] text-fg-muted">{m.quant}</span>
                <span className="tabular w-[64px] shrink-0 text-right text-[12px] text-fg-faint">{formatBytes(m.sizeBytes)}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

/** Компактная карта памяти: что из модели лежит в VRAM и в RAM, плюс занятое другими. */
function MemoryStrip(): React.JSX.Element | null {
  const { status, preview } = useEngine()
  const live = useHardware((s) => s.live)
  const info = useHardware((s) => s.info)
  const plan = status.state === 'ready' || status.state === 'loading' ? (status.plan ?? preview) : preview
  const vramTotalMiB = live?.vramTotalMiB || info?.gpus[0]?.vramTotalMiB || 0
  const ramTotalMiB = live?.ramTotalMiB || info?.ramTotalMiB || 0
  if (!vramTotalMiB && !ramTotalMiB) return null
  const MiB = 1024 * 1024
  const loaded = status.state === 'ready'
  const segs = (side: 'vram' | 'ram'): Array<{ id: MemoryComponentId; bytes: number }> =>
    (plan?.components ?? []).map((c) => ({ id: c.id, bytes: side === 'vram' ? c.vramBytes : c.ramBytes }))
  const ourVram = plan?.vramBytes ?? 0
  const ourRam = plan?.ramBytes ?? 0
  // Пока модель загружена, живое «занято» уже включает её — остальное приходится на другие программы.
  const vramOther = Math.max(0, (live?.vramUsedMiB ?? 0) * MiB - (loaded ? ourVram : 0))
  const ramOther = Math.max(0, (live?.ramUsedMiB ?? 0) * MiB - (loaded ? ourRam : 0))

  return (
    <div className="flex w-[300px] shrink-0 flex-col gap-1.5" title={loaded ? 'Загруженная модель' : 'Если загрузить с текущими настройками'}>
      {vramTotalMiB > 0 && (
        <div className="flex items-center gap-2">
          <span className="w-9 text-[11px] text-fg-faint">VRAM</span>
          <MemoryBar label="VRAM" segments={segs('vram')} capacityBytes={vramTotalMiB * MiB} otherBytes={vramOther} height={7} className="flex-1" />
          <span className="tabular w-[86px] text-right text-[11px] text-fg-muted">
            {formatMiB((live?.vramUsedMiB ?? 0) + (loaded ? 0 : ourVram / MiB))} / {formatMiB(vramTotalMiB, 0)}
          </span>
        </div>
      )}
      <div className="flex items-center gap-2">
        <span className="w-9 text-[11px] text-fg-faint">RAM</span>
        <MemoryBar label="RAM" segments={segs('ram')} capacityBytes={ramTotalMiB * MiB} otherBytes={ramOther} height={7} className="flex-1" />
        <span className="tabular w-[86px] text-right text-[11px] text-fg-muted">
          {formatMiB((live?.ramUsedMiB ?? 0) + (loaded ? 0 : ourRam / MiB))} / {formatMiB(ramTotalMiB, 0)}
        </span>
      </div>
    </div>
  )
}

export function TopBar(): React.JSX.Element {
  const { status, selectedModelId, load, unload, loadError, preview } = useEngine()
  const busy = status.state === 'starting' || status.state === 'loading' || status.state === 'stopping'
  const loadedThis = status.state === 'ready' && status.modelId === selectedModelId
  const blocked = preview?.fit === 'none'

  return (
    <div className="border-b border-line bg-panel">
      <div className="flex items-center gap-3 px-4 py-2.5">
        <ModelPicker />
        {loadedThis ? (
          <Button variant="secondary" icon={<Power size={14} />} onClick={() => void unload()}>
            Выгрузить
          </Button>
        ) : (
          <Button
            variant="primary"
            disabled={!selectedModelId || busy}
            onClick={() => void load()}
            icon={busy ? <Loader2 size={14} className="animate-spin" /> : undefined}
            title={blocked ? 'По расчёту модель не поместится в память — проверьте вкладку «Память»' : undefined}
          >
            {busy
              ? status.state === 'stopping'
                ? 'Выгружаю…'
                : `Загружаю${status.loadProgress ? ` ${Math.round(status.loadProgress * 100)}%` : '…'}`
              : 'Загрузить'}
          </Button>
        )}
        {status.state === 'ready' && status.engine && (
          <span className="hidden text-[12px] text-fg-faint xl:inline">
            {engineName(status.engine)}, контекст {status.contextLength?.toLocaleString('ru-RU')}
          </span>
        )}
        <div className="flex-1" />
        <MemoryStrip />
      </div>
      {(loadError || status.state === 'error') && (
        <div className="border-t border-danger/30 bg-danger/10 px-4 py-2 text-[12.5px] whitespace-pre-wrap text-danger">
          {loadError ?? status.error}
        </div>
      )}
    </div>
  )
}
