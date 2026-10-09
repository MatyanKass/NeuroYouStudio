import { Save } from 'lucide-react'
import { useState } from 'react'
import { DEFAULT_LOAD_CONFIG, type LoadConfig } from '@shared/config'
import { call } from '@/lib/api'
import { cn } from '@/lib/format'
import { useEngine, useModels, useSettings } from '@/store/app'
import { Button } from '@/components/ui/Button'
import { LoadSettingsForm } from '@/components/settings/LoadSettings'
import { PredictionSettings } from '@/components/settings/PredictionSettings'
import { MemoryPanel } from '@/components/memory/MemoryPanel'

type Tab = 'generation' | 'load' | 'memory'

const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'generation', label: 'Генерация' },
  { id: 'load', label: 'Загрузка' },
  { id: 'memory', label: 'Память' }
]

function LoadTab(): React.JSX.Element {
  const selectedModelId = useEngine((s) => s.selectedModelId)
  const draftLoad = useEngine((s) => s.draftLoad)
  const setDraftLoad = useEngine((s) => s.setDraftLoad)
  const status = useEngine((s) => s.status)
  const model = useModels((s) => s.models.find((m) => m.id === selectedModelId))
  const defaultLoad = useSettings((s) => s.settings?.defaultLoad)
  const [saved, setSaved] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  if (!selectedModelId || !draftLoad) {
    return <p className="px-4 py-6 text-[13px] text-fg-faint">Выберите модель вверху — здесь появятся её настройки загрузки.</p>
  }
  const changedSinceLoad =
    status.state === 'ready' && status.modelId === selectedModelId && JSON.stringify(status.load) !== JSON.stringify(draftLoad)
  return (
    <div className="pb-6">
      {changedSinceLoad && (
        <div className="border-b border-line bg-accent-soft px-4 py-2 text-[12.5px] text-fg">
          Настройки изменились. Нажмите «Загрузить» вверху, чтобы перезагрузить модель с ними.
        </div>
      )}
      <LoadSettingsForm model={model} value={draftLoad} onChange={(l: LoadConfig) => setDraftLoad(l)} />
      <div className="flex flex-wrap gap-2 px-4 pt-3">
        <Button
          size="sm"
          icon={<Save size={13} />}
          onClick={() =>
            void call('settings:setPerModelLoad', selectedModelId, draftLoad).then(
              () => {
                setSaveError(null)
                setSaved(true)
                setTimeout(() => setSaved(false), 1500)
              },
              (e: unknown) => setSaveError(e instanceof Error ? e.message : String(e))
            )
          }
        >
          {saved ? 'Сохранено' : 'Запомнить для этой модели'}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          title="Вернуть общие настройки загрузки из раздела «Настройки» (раскладка памяти не меняется)"
          onClick={() => setDraftLoad({ ...(defaultLoad ?? DEFAULT_LOAD_CONFIG), memory: draftLoad.memory })}
        >
          Сбросить
        </Button>
      </div>
      {saveError && <p className="px-4 pt-2 text-[12.5px] text-danger">Не удалось сохранить: {saveError}</p>}
    </div>
  )
}

export function RightPanel(): React.JSX.Element {
  const [tab, setTab] = useState<Tab>('memory')
  return (
    <aside className="flex w-[320px] shrink-0 flex-col border-l border-line bg-panel xl:w-[352px]">
      <div
        className="flex gap-1 border-b border-line px-3 pt-2.5"
        role="tablist"
        aria-label="Настройки модели"
        onKeyDown={(e) => {
          // Стрелки переключают вкладки, как в обычном tablist.
          if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return
          const i = TABS.findIndex((t) => t.id === tab)
          const next = TABS[(i + (e.key === 'ArrowRight' ? 1 : TABS.length - 1)) % TABS.length]!
          setTab(next.id)
          document.getElementById(`rp-tab-${next.id}`)?.focus()
        }}
      >
        {TABS.map((t) => (
          <button
            key={t.id}
            id={`rp-tab-${t.id}`}
            role="tab"
            aria-selected={tab === t.id}
            aria-controls="rp-tabpanel"
            tabIndex={tab === t.id ? 0 : -1}
            onClick={() => setTab(t.id)}
            className={cn(
              '-mb-px border-b-2 px-2.5 pb-2 text-[13px]',
              tab === t.id ? 'border-accent font-medium text-fg' : 'border-transparent text-fg-faint hover:text-fg-muted'
            )}
          >
            {t.label}
          </button>
        ))}
      </div>
      {/* key: у каждой вкладки своя прокрутка с начала */}
      <div key={tab} id="rp-tabpanel" role="tabpanel" aria-labelledby={`rp-tab-${tab}`} className="min-h-0 flex-1 overflow-y-auto">
        {tab === 'generation' && <PredictionSettings />}
        {tab === 'load' && <LoadTab />}
        {tab === 'memory' && <MemoryPanel />}
      </div>
    </aside>
  )
}
