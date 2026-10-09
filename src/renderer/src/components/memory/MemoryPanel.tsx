import { AlertTriangle, Copy, Wand2 } from 'lucide-react'
import { useState } from 'react'
import type { MemoryLayout, MemoryProfileId, Place } from '@shared/config'
import type { MemoryActual, MemoryComponent, MemoryComponentId, MemoryPlan } from '@shared/types'
import { useEngine, useHardware, useModels } from '@/store/app'
import { MEM_COLOR } from '@/lib/memory'
import { cn, formatBytes, formatMiB } from '@/lib/format'
import { FitBadge } from '@/components/FitBadge'
import { Button } from '@/components/ui/Button'
import { Field, NumberInput, Slider } from '@/components/ui/Field'
import { MemoryBar } from './MemoryBar'

const PROFILES: Array<{ id: MemoryProfileId; title: string; text: string }> = [
  { id: 'speed', title: 'Максимальная скорость', text: 'Всё в видеопамять. Что не влезло — сначала эксперты MoE, потом целые слои уходят в RAM.' },
  {
    id: 'userSplit',
    title: 'VRAM: Flash Attention + модель, RAM: контекст',
    text: 'Веса и буферы внимания на видеокарте, KV-кэш в оперативной памяти. Освобождает VRAM под модель покрупнее, но на длинном контексте генерация медленнее.'
  },
  {
    id: 'longContext',
    title: 'Длинный контекст',
    text: 'Attention и KV-кэш всех слоёв остаются в VRAM, при нехватке в RAM уходит FFN. Выгодно для документов и долгих диалогов.'
  },
  { id: 'saveVram', title: 'Экономия видеопамяти', text: 'Модель занимает не больше половины VRAM — остальное остаётся играм и другим программам.' }
]

/** Какое поле раскладки отвечает за компонент (null — нельзя переносить). */
function placeOf(id: MemoryComponentId, l: MemoryLayout): Place | null {
  switch (id) {
    case 'attn':
      return l.attention
    case 'ffn':
      return l.ffn
    case 'experts':
      return l.expertsCpuLayers === 0 ? 'vram' : 'ram'
    case 'output':
      return l.output
    case 'kv':
      return l.kvCache
    case 'mmproj':
      return l.mmproj
    default:
      return null
  }
}

function withPlace(id: MemoryComponentId, l: MemoryLayout, p: Place): MemoryLayout {
  switch (id) {
    case 'attn':
      return { ...l, attention: p }
    case 'ffn':
      return { ...l, ffn: p }
    case 'experts':
      return { ...l, expertsCpuLayers: p === 'vram' ? 0 : -1 }
    case 'output':
      return { ...l, output: p }
    case 'kv':
      return { ...l, kvCache: p }
    case 'mmproj':
      return { ...l, mmproj: p }
    default:
      return l
  }
}

function PlaceToggle({
  value,
  onChange,
  disabled
}: {
  value: Place | null
  onChange: (p: Place) => void
  disabled: boolean
}): React.JSX.Element {
  return (
    <div className={cn('flex rounded-[5px] bg-bg p-[2px] text-[11.5px]', disabled && 'opacity-60')}>
      {(['vram', 'ram'] as const).map((p) => (
        <button
          key={p}
          disabled={disabled}
          onClick={() => onChange(p)}
          className={cn(
            'rounded-[4px] px-1.5 py-[1px]',
            value === p ? 'bg-raised text-fg' : 'text-fg-faint',
            !disabled && value !== p && 'hover:text-fg-muted'
          )}
        >
          {p === 'vram' ? 'VRAM' : 'RAM'}
        </button>
      ))}
    </div>
  )
}

function ComponentRow({
  c,
  layout,
  manual,
  onLayout
}: {
  c: MemoryComponent
  layout: MemoryLayout
  manual: boolean
  onLayout: (l: MemoryLayout) => void
}): React.JSX.Element {
  const place = placeOf(c.id, layout)
  const split = c.vramBytes > 0 && c.ramBytes > 0
  return (
    <div className="flex items-center gap-2 py-[5px]" title={c.hint}>
      <span className="h-2.5 w-2.5 shrink-0 rounded-[2px]" style={{ background: MEM_COLOR[c.id] }} />
      <span className="min-w-0 flex-1 truncate text-[12.5px] text-fg-muted">{c.label}</span>
      <span className="tabular w-[92px] text-right text-[12px] text-fg">
        {split ? (
          <>
            {formatBytes(c.vramBytes)}
            <span className="text-fg-faint"> + {formatBytes(c.ramBytes)}</span>
          </>
        ) : (
          formatBytes(c.vramBytes + c.ramBytes)
        )}
      </span>
      {c.movable && place ? (
        <PlaceToggle value={split ? null : place} disabled={!manual} onChange={(p) => onLayout(withPlace(c.id, layout, p))} />
      ) : (
        <span className="w-[74px] text-right text-[11px] text-fg-faint">{c.vramBytes > 0 ? 'VRAM' : 'RAM'}</span>
      )}
    </div>
  )
}

function ActualTable({ actual, plan }: { actual: MemoryActual; plan: MemoryPlan }): React.JSX.Element {
  const devices = new Set<string>()
  for (const g of [actual.model, actual.kv, actual.compute]) for (const d of Object.keys(g)) devices.add(d)
  const rows: Array<[string, Record<string, number>]> = [
    ['Веса', actual.model],
    ['KV-кэш', actual.kv],
    ['Буферы', actual.compute]
  ]
  const gpuActual = [...devices].filter((d) => /cuda|gpu|vulkan/i.test(d))
  const sumGpu = rows.reduce((s, [, g]) => s + gpuActual.reduce((a, d) => a + (g[d] ?? 0), 0), 0)
  return (
    <div className="mt-1">
      <table className="tabular w-full text-[12px]">
        <thead>
          <tr className="text-fg-faint">
            <th className="py-1 text-left font-normal">Факт, МиБ</th>
            {[...devices].map((d) => (
              <th key={d} className="py-1 text-right font-normal">
                {d}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map(([name, g]) => (
            <tr key={name} className="border-t border-line">
              <td className="py-1 text-fg-muted">{name}</td>
              {[...devices].map((d) => (
                <td key={d} className="py-1 text-right text-fg">
                  {g[d] ? Math.round(g[d]).toLocaleString('ru-RU') : '—'}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-1.5 text-[11.5px] text-fg-faint">
        На видеокарте по логам движка {formatMiB(sumGpu)}, по плану было {formatBytes(plan.vramBytes)}.
      </p>
    </div>
  )
}

export function MemoryPanel(): React.JSX.Element {
  const { draftLoad, setDraftLoad, preview, previewError, status, selectedModelId } = useEngine()
  const live = useHardware((s) => s.live)
  const info = useHardware((s) => s.info)
  const model = useModels((s) => s.models.find((m) => m.id === selectedModelId))
  const [argsOpen, setArgsOpen] = useState(false)

  if (!draftLoad || !selectedModelId) {
    return <p className="px-4 py-6 text-[13px] text-fg-faint">Выберите модель вверху — здесь появится раскладка памяти.</p>
  }

  const layout = draftLoad.memory
  const manual = layout.mode === 'manual'
  const plan = preview
  const shown = manual ? layout : (plan?.resolved ?? layout)
  const setLayout = (l: MemoryLayout): void => setDraftLoad({ ...draftLoad, memory: l })
  const nLayers = plan?.nLayers || model?.arch?.nLayers || 0
  const loadedThis = status.state === 'ready' && status.modelId === selectedModelId

  // Пока эта модель загружена, её собственная VRAM входит в «занято» — вычитаем, чтобы не считать дважды.
  const vramTotal = (info?.gpus[0]?.vramTotalMiB ?? live?.vramTotalMiB ?? 0) * 1024 * 1024
  const ramTotal = (info?.ramTotalMiB ?? live?.ramTotalMiB ?? 0) * 1024 * 1024
  const vramOther = Math.max(0, vramTotal - (plan?.vramAvailableBytes ?? vramTotal) - layout.vramReserveMiB * 1024 * 1024)
  const ramOther = Math.max(0, ramTotal - (plan?.ramAvailableBytes ?? ramTotal))

  const segs = (side: 'vram' | 'ram'): Array<{ id: MemoryComponentId; bytes: number }> =>
    (plan?.components ?? []).map((c) => ({ id: c.id, bytes: side === 'vram' ? c.vramBytes : c.ramBytes }))

  return (
    <div className="pb-6">
      <div className="border-b border-line px-4 pt-3 pb-3">
        <div className="mb-3 flex rounded-[var(--radius-ctl)] bg-bg p-[3px]">
          {(['auto', 'manual'] as const).map((m) => (
            <button
              key={m}
              onClick={() => setLayout(m === 'manual' && plan ? { ...plan.resolved, mode: 'manual' } : { ...layout, mode: m })}
              className={cn(
                'flex-1 rounded-[5px] py-1 text-[12.5px]',
                layout.mode === m ? 'bg-raised font-medium text-fg' : 'text-fg-faint hover:text-fg-muted'
              )}
            >
              {m === 'auto' ? 'Автоподбор' : 'Вручную'}
            </button>
          ))}
        </div>

        <MemoryBar label="VRAM" segments={segs('vram')} capacityBytes={vramTotal} otherBytes={vramOther} height={18} showScale />
        <MemoryBar label="RAM" segments={segs('ram')} capacityBytes={ramTotal} otherBytes={ramOther} height={10} showScale className="mt-2.5" />

        <div className="mt-3 flex flex-wrap items-center gap-2">
          {plan && <FitBadge fit={plan.fit} />}
          {plan && nLayers > 0 && (
            <span className="tabular text-[12px] text-fg-faint">
              Слоёв на GPU: {shown.gpuLayers < 0 ? nLayers : Math.min(shown.gpuLayers, nLayers)} из {nLayers}
            </span>
          )}
          {plan && <span className="text-[12px] text-fg-faint">движок: {engineName(plan.engine)}</span>}
        </div>
        {previewError && <p className="mt-2 text-[12.5px] text-danger">{previewError}</p>}
        {plan?.warnings.map((w) => (
          <p key={w} className="mt-2 flex gap-1.5 text-[12.5px] text-warn">
            <AlertTriangle size={14} className="mt-[2px] shrink-0" />
            {w}
          </p>
        ))}
      </div>

      {!manual && (
        <div className="border-b border-line px-4 py-3">
          <div className="mb-1.5 text-[13px] font-semibold text-fg">Профиль</div>
          <div className="flex flex-col gap-1" role="radiogroup">
            {PROFILES.map((p) => (
              <button
                key={p.id}
                role="radio"
                aria-checked={layout.profile === p.id}
                onClick={() => setLayout({ ...layout, profile: p.id })}
                className={cn(
                  'flex gap-2.5 rounded-[var(--radius-ctl)] px-2 py-1.5 text-left',
                  layout.profile === p.id ? 'bg-accent-soft' : 'hover:bg-panel-2'
                )}
              >
                <span
                  className={cn(
                    'mt-[3px] h-3 w-3 shrink-0 rounded-full border',
                    layout.profile === p.id ? 'border-accent bg-accent' : 'border-line-strong'
                  )}
                />
                <span>
                  <span className={cn('block text-[13px]', layout.profile === p.id ? 'text-fg' : 'text-fg-muted')}>
                    {p.title}
                  </span>
                  <span className="block text-[12px] leading-snug text-fg-faint">{p.text}</span>
                </span>
              </button>
            ))}
          </div>
          {plan && (
            <Button size="sm" variant="ghost" className="mt-2" icon={<Wand2 size={14} />} onClick={() => setLayout({ ...plan.resolved, mode: 'manual' })}>
              Подправить вручную
            </Button>
          )}
        </div>
      )}

      <div className="border-b border-line px-4 py-3">
        <div className="mb-1">
          <div className="text-[13px] font-semibold text-fg">Что где лежит</div>
          {!manual && <div className="text-[11.5px] text-fg-faint">Чтобы перенести компонент, переключитесь на «Вручную»</div>}
        </div>
        {plan?.components.length ? (
          plan.components
            .filter((c) => c.vramBytes + c.ramBytes > 0)
            .map((c) => <ComponentRow key={c.id} c={c} layout={shown} manual={manual} onLayout={setLayout} />)
        ) : (
          <p className="py-2 text-[12.5px] text-fg-faint">Считаю раскладку…</p>
        )}
      </div>

      {manual && (
        <div className="border-b border-line px-4 py-3">
          {nLayers > 0 && (
            <div className="py-1">
              <div className="mb-1 flex items-center justify-between text-[13px] text-fg-muted">
                <span>Слоёв на GPU</span>
                <span className="tabular text-fg">
                  {layout.gpuLayers < 0 ? `все (${nLayers})` : `${layout.gpuLayers} из ${nLayers}`}
                </span>
              </div>
              <Slider
                label="Слоёв на GPU"
                value={layout.gpuLayers < 0 ? nLayers : Math.min(layout.gpuLayers, nLayers)}
                min={0}
                max={nLayers}
                onChange={(v) => setLayout({ ...layout, gpuLayers: v >= nLayers ? -1 : v })}
              />
            </div>
          )}
          {model?.isMoe && nLayers > 0 && (
            <div className="py-1">
              <div className="mb-1 flex items-center justify-between text-[13px] text-fg-muted">
                <span title="Эксперты MoE первых N слоёв лежат в RAM (--n-cpu-moe). Самый выгодный способ уместить большую MoE-модель.">
                  Эксперты MoE в RAM
                </span>
                <span className="tabular text-fg">
                  {layout.expertsCpuLayers < 0 ? `все слои` : `${layout.expertsCpuLayers} слоёв`}
                </span>
              </div>
              <Slider
                label="Эксперты MoE в RAM"
                value={layout.expertsCpuLayers < 0 ? nLayers : layout.expertsCpuLayers}
                min={0}
                max={nLayers}
                onChange={(v) => setLayout({ ...layout, expertsCpuLayers: v >= nLayers ? -1 : v })}
              />
            </div>
          )}
          <Field label="Запас VRAM, МиБ" hint="Сколько видеопамяти оставить свободной для системы и других программ.">
            <NumberInput
              value={layout.vramReserveMiB}
              onChange={(v) => setLayout({ ...layout, vramReserveMiB: Math.round(v) })}
              min={0}
              max={16384}
              step={128}
            />
          </Field>
        </div>
      )}

      {loadedThis && status.actual && plan && (
        <div className="border-b border-line px-4 py-3">
          <div className="text-[13px] font-semibold text-fg">План и факт</div>
          <ActualTable actual={status.actual} plan={status.plan ?? plan} />
        </div>
      )}

      {plan && plan.args.length > 0 && (
        <div className="px-4 py-3">
          <button
            onClick={() => setArgsOpen(!argsOpen)}
            className="text-[12.5px] text-fg-faint hover:text-fg-muted"
            aria-expanded={argsOpen}
          >
            {argsOpen ? 'Скрыть аргументы движка' : 'Показать аргументы движка'}
          </button>
          {argsOpen && (
            <div className="relative mt-1.5 rounded-[var(--radius-ctl)] bg-bg p-2 pr-8 font-mono text-[11.5px] leading-relaxed break-all text-fg-muted">
              {plan.args.join(' ')}
              <button
                className="absolute top-1.5 right-1.5 text-fg-faint hover:text-fg"
                aria-label="Скопировать аргументы"
                onClick={() => void navigator.clipboard.writeText(plan.args.join(' '))}
              >
                <Copy size={13} />
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export function engineName(e: string): string {
  return e === 'llamacpp' ? 'llama.cpp' : e === 'ikllama' ? 'ik_llama.cpp' : e === 'exl3' ? 'ExLlamaV3' : e
}
