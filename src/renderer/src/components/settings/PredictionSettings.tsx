import { Download, Save, Trash2, Upload } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { DEFAULT_PREDICTION_CONFIG, deepMerge, type DeepPartial, type PredictionConfig } from '@shared/config'
import { call } from '@/lib/api'
import { usePresets, useSettings } from '@/store/app'
import { IconButton, Button } from '@/components/ui/Button'
import { Field, NumberInput, Section, Select, SliderField, Switch, TextArea, TextInput, ToggleNumberField } from '@/components/ui/Field'

/** Черновик настроек генерации: правится мгновенно, в настройки уходит с задержкой. */
function usePredictionDraft(): [PredictionConfig, (p: PredictionConfig) => void] {
  const stored = useSettings((s) => s.settings?.defaultPrediction)
  const update = useSettings((s) => s.update)
  const [draft, setDraft] = useState<PredictionConfig>(stored ?? DEFAULT_PREDICTION_CONFIG)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const dirty = useRef(false)

  useEffect(() => {
    if (stored && !dirty.current) setDraft(stored)
  }, [stored])

  const change = (p: PredictionConfig): void => {
    setDraft(p)
    dirty.current = true
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => {
      // Массивы (стоп-строки) заменяются целиком — передаём весь объект.
      void update({ defaultPrediction: p }).finally(() => {
        dirty.current = false
      })
    }, 300)
  }
  return [draft, change]
}

function PresetBar({ value, onApply }: { value: PredictionConfig; onApply: (p: PredictionConfig) => void }): React.JSX.Element {
  const { presets, save, remove, refresh } = usePresets()
  const activeId = useSettings((s) => s.settings?.activePresetId ?? '')
  const update = useSettings((s) => s.update)
  const [naming, setNaming] = useState(false)
  const [name, setName] = useState('')
  const active = presets.find((p) => p.id === activeId)

  const choose = (id: string): void => {
    void update({ activePresetId: id })
    const p = presets.find((x) => x.id === id)
    if (p) onApply(deepMerge(DEFAULT_PREDICTION_CONFIG, p.prediction as DeepPartial<PredictionConfig>))
  }

  return (
    <div className="border-b border-line px-4 py-3">
      <div className="flex items-center gap-1.5">
        <Select
          label="Пресет"
          className="max-w-none flex-1"
          value={activeId}
          onChange={choose}
          options={[{ value: '', label: 'Без пресета' }, ...presets.map((p) => ({ value: p.id, label: p.name }))]}
        />
        <IconButton
          label={active && !active.id.startsWith('builtin-') ? 'Сохранить изменения в пресет' : 'Сохранить как новый пресет'}
          onClick={() => {
            if (active && !active.id.startsWith('builtin-')) void save({ ...active, prediction: value })
            else {
              setName('')
              setNaming(true)
            }
          }}
        >
          <Save size={14} />
        </IconButton>
        <IconButton label="Импорт пресета из файла" onClick={() => void call('presets:import').then(() => refresh())}>
          <Upload size={14} />
        </IconButton>
        {active && (
          <IconButton label="Экспорт пресета в файл" onClick={() => void call('presets:export', active.id)}>
            <Download size={14} />
          </IconButton>
        )}
        {active && !active.id.startsWith('builtin-') && (
          <IconButton
            label="Удалить пресет"
            onClick={() => {
              void remove(active.id)
              void update({ activePresetId: '' })
            }}
          >
            <Trash2 size={14} />
          </IconButton>
        )}
      </div>
      {naming && (
        <div className="mt-2 flex gap-1.5">
          <TextInput
            value={name}
            onChange={setName}
            placeholder="Название пресета"
            className="h-7 text-[13px]"
            onEnter={() => name.trim() && void save({ id: '', name: name.trim(), prediction: value, createdAt: 0, updatedAt: 0 }).then(() => setNaming(false))}
          />
          <Button
            size="sm"
            variant="primary"
            disabled={!name.trim()}
            onClick={() =>
              void save({ id: '', name: name.trim(), prediction: value, createdAt: 0, updatedAt: 0 }).then(() => setNaming(false))
            }
          >
            Сохранить
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setNaming(false)}>
            Отмена
          </Button>
        </div>
      )}
    </div>
  )
}

export function PredictionSettings(): React.JSX.Element {
  const [p, setP] = usePredictionDraft()
  const set = <K extends keyof PredictionConfig>(k: K, v: PredictionConfig[K]): void => setP({ ...p, [k]: v })
  const [stopDraft, setStopDraft] = useState(p.stopStrings.join('\n'))
  const stopRef = useRef(stopDraft)
  useEffect(() => {
    stopRef.current = stopDraft
  }, [stopDraft])
  // Синхронизация при смене пресета; пустые строки в процессе набора не сбрасываем.
  useEffect(() => {
    const fromDraft = stopRef.current.split('\n').filter((s) => s.length > 0)
    if (fromDraft.join('\n') !== p.stopStrings.join('\n')) setStopDraft(p.stopStrings.join('\n'))
  }, [p.stopStrings])

  return (
    <div className="pb-6">
      <PresetBar value={p} onApply={setP} />

      <Section title="Системный промпт">
        <TextArea
          rows={5}
          value={p.systemPrompt}
          onChange={(v) => set('systemPrompt', v)}
          placeholder="Например: «Ты — опытный программист. Отвечай кратко и по делу.»"
        />
      </Section>

      <Section title="Генерация">
        <SliderField
          label="Температура"
          hint="Чем выше, тем разнообразнее и «творческее» ответы. 0 — всегда самый вероятный токен."
          value={p.temperature}
          onChange={(v) => set('temperature', v)}
          min={0}
          max={2}
          step={0.05}
          inputMax={5}
        />
        <ToggleNumberField
          label="Ограничить длину ответа"
          hint="Максимум токенов в одном ответе."
          value={p.maxTokens}
          onChange={(v) => set('maxTokens', v)}
          min={1}
          max={1_000_000}
          offLabel="Без ограничения"
        />
        <Field label="Переполнение контекста" hint="Что делать, когда диалог перестаёт помещаться в контекст модели.">
          <Select
            label="Переполнение контекста"
            value={p.contextOverflow}
            onChange={(v) => set('contextOverflow', v)}
            options={[
              { value: 'truncateMiddle', label: 'Обрезать середину' },
              { value: 'rollingWindow', label: 'Скользящее окно' },
              { value: 'stopAtLimit', label: 'Остановиться' }
            ]}
          />
        </Field>
        <Field label="Стоп-строки" hint="Генерация останавливается, встретив любую из строк. По одной на строке." stacked>
          <TextArea
            rows={2}
            mono
            value={stopDraft}
            onChange={(v) => {
              setStopDraft(v)
              set(
                'stopStrings',
                v.split('\n').filter((s) => s.length > 0)
              )
            }}
          />
        </Field>
      </Section>

      <Section title="Сэмплирование">
        <Field label="Top K" hint="Выбирать только из K самых вероятных токенов. 0 — выключено.">
          <NumberInput value={p.topK} onChange={(v) => set('topK', Math.round(v))} min={0} max={500} />
        </Field>
        <ToggleNumberField label="Top P" hint="Ядерное сэмплирование: самые вероятные токены с суммарной вероятностью P." value={p.topP} onChange={(v) => set('topP', v)} min={0} max={1} step={0.01} />
        <ToggleNumberField label="Min P" hint="Отбросить токены, вероятность которых меньше P × вероятность лучшего." value={p.minP} onChange={(v) => set('minP', v)} min={0} max={1} step={0.01} />
        <ToggleNumberField label="Штраф за повторение" hint="Больше 1 — меньше повторов." value={p.repeatPenalty} onChange={(v) => set('repeatPenalty', v)} min={0.5} max={2} step={0.01} />
        <ToggleNumberField label="Штраф за появление" hint="Наказывает токены, которые уже встречались." value={p.presencePenalty} onChange={(v) => set('presencePenalty', v)} min={-2} max={2} step={0.05} />
        <ToggleNumberField label="Штраф за частоту" hint="Наказывает токены пропорционально числу повторов." value={p.frequencyPenalty} onChange={(v) => set('frequencyPenalty', v)} min={-2} max={2} step={0.05} />
      </Section>

      <Section title="Дополнительное сэмплирование" defaultOpen={false}>
        <ToggleNumberField label="Вероятность XTC" hint="XTC иногда убирает самые предсказуемые токены — текст становится живее." value={p.xtcProbability} onChange={(v) => set('xtcProbability', v)} min={0} max={1} step={0.05} />
        <ToggleNumberField label="Порог XTC" value={p.xtcThreshold} onChange={(v) => set('xtcThreshold', v)} min={0} max={0.5} step={0.01} />
        <ToggleNumberField label="Typical P" value={p.typicalP} onChange={(v) => set('typicalP', v)} min={0} max={1} step={0.01} />
        <Field label="Mirostat" hint="Держит «удивительность» текста на заданном уровне. Отключает Top K/P.">
          <Select
            label="Mirostat"
            value={String(p.mirostat.version) as '0' | '1' | '2'}
            onChange={(v) => set('mirostat', { ...p.mirostat, version: Number(v) as 0 | 1 | 2 })}
            options={[
              { value: '0', label: 'Выкл' },
              { value: '1', label: 'Mirostat 1' },
              { value: '2', label: 'Mirostat 2' }
            ]}
          />
        </Field>
        {p.mirostat.version > 0 && (
          <>
            <Field label="Целевая энтропия (tau)">
              <NumberInput value={p.mirostat.targetEntropy} onChange={(v) => set('mirostat', { ...p.mirostat, targetEntropy: v })} min={0} max={20} step={0.1} />
            </Field>
            <Field label="Скорость обучения (eta)">
              <NumberInput value={p.mirostat.learningRate} onChange={(v) => set('mirostat', { ...p.mirostat, learningRate: v })} min={0} max={1} step={0.01} />
            </Field>
          </>
        )}
        <ToggleNumberField label="Сид" hint="Одинаковый сид и настройки дают одинаковый ответ." value={p.seed} onChange={(v) => set('seed', v)} min={-1} offLabel="Случайный" />
        <Field label="Logit bias" hint='JSON-массив пар [id токена, сдвиг], например [[15043, -5], [1234, "-inf"]].' stacked>
          <TextArea rows={2} mono value={p.logitBias} onChange={(v) => set('logitBias', v)} placeholder="[[15043, -5]]" />
        </Field>
      </Section>

      <Section title="Рассуждения" defaultOpen={false}>
        <Field label="Разрешить модели думать" hint="Для моделей с режимом рассуждений (Qwen3, DeepSeek R1 и др.). Выключите для быстрых коротких ответов.">
          <Switch checked={p.reasoning.enableThinking} onChange={(v) => set('reasoning', { ...p.reasoning, enableThinking: v })} label="Разрешить рассуждения" />
        </Field>
        <Field label="Выделять рассуждения" hint="Прятать текст между тегами в сворачиваемый блок.">
          <Switch checked={p.reasoning.parsing} onChange={(v) => set('reasoning', { ...p.reasoning, parsing: v })} label="Выделять рассуждения" />
        </Field>
        {p.reasoning.parsing && (
          <div className="flex gap-2 py-1">
            <TextInput value={p.reasoning.startString} onChange={(v) => set('reasoning', { ...p.reasoning, startString: v })} className="h-7 font-mono text-[12px]" />
            <TextInput value={p.reasoning.endString} onChange={(v) => set('reasoning', { ...p.reasoning, endString: v })} className="h-7 font-mono text-[12px]" />
          </div>
        )}
      </Section>

      <Section title="Структурированный вывод" defaultOpen={false}>
        <Field label="Формат" hint="Заставляет модель отвечать строго по JSON-схеме или грамматике GBNF.">
          <Select
            label="Формат вывода"
            value={p.structured.type}
            onChange={(v) => set('structured', { ...p.structured, type: v })}
            options={[
              { value: 'none', label: 'Обычный текст' },
              { value: 'json', label: 'JSON-схема' },
              { value: 'gbnf', label: 'Грамматика GBNF' }
            ]}
          />
        </Field>
        {p.structured.type === 'json' && (
          <TextArea rows={6} mono value={p.structured.jsonSchema} onChange={(v) => set('structured', { ...p.structured, jsonSchema: v })} placeholder='{"type": "object", "properties": {"ответ": {"type": "string"}}}' />
        )}
        {p.structured.type === 'gbnf' && (
          <TextArea rows={6} mono value={p.structured.gbnf} onChange={(v) => set('structured', { ...p.structured, gbnf: v })} placeholder='root ::= "да" | "нет"' />
        )}
      </Section>

      <div className="px-4 pt-3">
        <Button size="sm" variant="ghost" onClick={() => setP(DEFAULT_PREDICTION_CONFIG)}>
          Сбросить к значениям по умолчанию
        </Button>
      </div>
    </div>
  )
}
