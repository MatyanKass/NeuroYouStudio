import { Check, Loader2 } from 'lucide-react'
import { call } from '@/lib/api'
import { formatBytes, formatMiB, cn } from '@/lib/format'
import { useHardware, useModels, useRuntimes } from '@/store/app'
import { useUi } from '@/store/ui'
import { Button } from '@/components/ui/Button'

/** Шаг «первого запуска»: номер, заголовок, состояние и действие. */
function Step({
  n,
  title,
  done,
  children
}: {
  n: number
  title: string
  done: boolean
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <li className="flex gap-3">
      <span
        className={cn(
          'mt-[1px] grid h-6 w-6 shrink-0 place-items-center rounded-full text-[12px] font-semibold',
          done ? 'bg-ok/20 text-ok' : 'bg-raised text-fg-muted'
        )}
      >
        {done ? <Check size={14} /> : n}
      </span>
      <div className="min-w-0 flex-1">
        <div className={cn('text-[14px] font-medium', done ? 'text-fg-muted' : 'text-fg')}>{title}</div>
        <div className="mt-1 text-[13px] text-fg-muted">{children}</div>
      </div>
    </li>
  )
}

/** Нужен ли стартовый экран: нет установленного движка llama.cpp-семейства или нет моделей. */
export function useNeedsOnboarding(): boolean {
  const hasEngine = useRuntimes((s) => s.runtimes.some((r) => r.installed && r.compatible && r.engine !== 'exl3'))
  const hasModel = useModels((s) => s.models.some((m) => !m.isEmbedding))
  const loaded = useRuntimes((s) => s.runtimes.length > 0)
  return loaded && !(hasEngine && hasModel)
}

/**
 * Стартовый экран, пока нет движка или моделей: что найдено в системе и что сделать дальше.
 */
export function Onboarding(): React.JSX.Element {
  const info = useHardware((s) => s.info)
  const runtimes = useRuntimes((s) => s.runtimes)
  const progress = useRuntimes((s) => s.progress)
  const allModels = useModels((s) => s.models)
  const models = allModels.filter((m) => !m.isEmbedding)
  const setPage = useUi((s) => s.setPage)

  const hasEngine = runtimes.some((r) => r.installed && r.compatible && r.engine !== 'exl3')
  const hasModel = models.length > 0

  const gpu = info?.gpus[0]
  // Основной движок — рекомендованная сборка llama.cpp под эту видеокарту.
  const rec = runtimes.find((r) => r.engine === 'llamacpp' && r.recommended && r.compatible)
  const p = rec ? progress[rec.id] : undefined
  const installing = Boolean(p && !p.done)

  return (
    <div className="mx-auto flex h-full max-w-[580px] flex-col justify-center gap-5 px-6 pb-16">
      <div>
        <h2 className="text-[22px] font-semibold tracking-tight text-fg">Добро пожаловать в NeuroYouStudio</h2>
        <p className="mt-1.5 text-[14px] text-fg-muted">
          {gpu
            ? `Видеокарта: ${gpu.name}, ${formatMiB(gpu.vramTotalMiB, 0)} видеопамяти. Оперативной памяти: ${formatMiB(info?.ramTotalMiB ?? 0, 0)}.`
            : 'Видеокарта NVIDIA не найдена — модели будут работать на процессоре, медленнее.'}
        </p>
      </div>
      <ol className="flex flex-col gap-4">
        <Step n={1} title="Установите движок" done={hasEngine}>
          {hasEngine ? (
            'Движок установлен.'
          ) : rec ? (
            <div className="flex flex-col gap-2">
              <span>
                Рекомендуем {rec.title} — подобран под вашу видеокарту и драйвер. Загрузка {formatBytes(rec.downloadBytes)}.
              </span>
              {p?.error && <span className="text-danger">{p.error}</span>}
              <div className="flex items-center gap-2">
                <Button
                  variant="primary"
                  disabled={installing}
                  icon={installing ? <Loader2 size={14} className="animate-spin" /> : undefined}
                  onClick={() => void call('runtimes:install', rec.id)}
                >
                  {installing ? `${p?.phase ?? 'Установка'}… ${p && p.totalBytes ? Math.round((p.receivedBytes / p.totalBytes) * 100) : 0}%` : 'Установить'}
                </Button>
                <Button variant="ghost" onClick={() => setPage('runtimes')}>
                  Все движки
                </Button>
              </div>
            </div>
          ) : (
            <Button variant="secondary" onClick={() => setPage('runtimes')}>
              Открыть раздел «Движки»
            </Button>
          )}
        </Step>
        <Step n={2} title="Скачайте модель" done={hasModel}>
          {hasModel ? (
            `Моделей скачано: ${models.length}.`
          ) : (
            <div className="flex flex-col gap-2">
              <span>
                В разделе «Поиск» у каждого варианта квантования есть отметка, поместится ли он в вашу видеокарту.
                {gpu && gpu.vramTotalMiB >= 15000 ? ' С 16 ГБ видеопамяти хорошо идут модели на 12–14B в Q4–Q6.' : ''}
              </span>
              <div>
                <Button variant={hasEngine ? 'primary' : 'secondary'} onClick={() => setPage('discover')}>
                  Найти модель
                </Button>
              </div>
            </div>
          )}
        </Step>
        <Step n={3} title="Загрузите модель и начните диалог" done={false}>
          Выберите модель в верхней панели и нажмите «Загрузить». Распределение памяти между видеокартой и RAM
          настраивается во вкладке «Память» справа.
        </Step>
      </ol>
    </div>
  )
}
