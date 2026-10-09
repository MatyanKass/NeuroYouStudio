import type { EngineChoice, KvCacheType, LoadConfig } from '@shared/config'
import type { LocalModel } from '@shared/types'
import { Field, NumberInput, Section, Select, SliderField, Switch, TextArea, ToggleNumberField } from '@/components/ui/Field'
import { useModels } from '@/store/app'

const KV_OPTIONS: Array<{ value: KvCacheType; label: string }> = [
  { value: 'f16', label: 'F16' },
  { value: 'bf16', label: 'BF16' },
  { value: 'f32', label: 'F32' },
  { value: 'q8_0', label: 'Q8_0' },
  { value: 'q5_1', label: 'Q5_1' },
  { value: 'q5_0', label: 'Q5_0' },
  { value: 'q4_1', label: 'Q4_1' },
  { value: 'q4_0', label: 'Q4_0' },
  { value: 'iq4_nl', label: 'IQ4_NL' }
]

const CTX_STEPS = [2048, 4096, 8192, 16384, 32768, 65536, 131072, 262144]

function engineOptions(model: LocalModel | undefined): Array<{ value: EngineChoice; label: string }> {
  if (model?.format === 'exl3') return [{ value: 'exl3', label: 'ExLlamaV3' }]
  return [
    { value: 'auto', label: 'Авто' },
    { value: 'llamacpp', label: 'llama.cpp' },
    { value: 'ikllama', label: 'ik_llama.cpp' }
  ]
}

/**
 * Настройки загрузки модели (как вкладка «Загрузка» в LM Studio).
 * Раскладка VRAM/RAM вынесена в отдельную панель «Память».
 */
export function LoadSettingsForm({
  model,
  value,
  onChange
}: {
  model: LocalModel | undefined
  value: LoadConfig
  onChange: (l: LoadConfig) => void
}): React.JSX.Element {
  const models = useModels((s) => s.models)
  const set = <K extends keyof LoadConfig>(k: K, v: LoadConfig[K]): void => onChange({ ...value, [k]: v })
  const maxCtx = model?.arch?.contextLengthMax || 131072
  const isExl3 = model?.format === 'exl3'
  const sliderMax = Math.max(2048, maxCtx)
  const draftCandidates = models.filter(
    (m) => m.format === (model?.format ?? 'gguf') && m.id !== model?.id && !m.isEmbedding
  )

  return (
    <div>
      <Section title="Основное">
        <Field label="Движок" hint="«Авто»: llama.cpp, если модель целиком влезает в VRAM; иначе ik_llama.cpp — он быстрее при выгрузке части модели в RAM.">
          <Select
            label="Движок"
            value={isExl3 ? 'exl3' : value.engine}
            onChange={(v) => set('engine', v)}
            options={engineOptions(model)}
          />
        </Field>
        <SliderField
          label="Длина контекста"
          hint="Сколько токенов модель держит в памяти диалога. Больше контекст — больше памяти под KV-кэш."
          value={value.contextLength}
          onChange={(v) => set('contextLength', Math.round(v))}
          min={512}
          max={sliderMax}
          step={256}
          suffix={
            model?.arch?.contextLengthMax ? (
              <button
                className="text-[12px] text-fg-faint hover:text-accent"
                title="Поставить максимум модели"
                onClick={() => set('contextLength', maxCtx)}
              >
                макс. {maxCtx.toLocaleString('ru-RU')}
              </button>
            ) : undefined
          }
        />
        <div className="-mt-0.5 mb-1 flex flex-wrap gap-1">
          {CTX_STEPS.filter((s) => s <= sliderMax).map((s) => (
            <button
              key={s}
              onClick={() => set('contextLength', s)}
              className={
                'tabular rounded px-1.5 py-0.5 text-[11.5px] ' +
                (value.contextLength === s ? 'bg-accent-soft text-accent' : 'text-fg-faint hover:bg-panel-2 hover:text-fg')
              }
            >
              {s >= 1024 ? `${s / 1024}K` : s}
            </button>
          ))}
        </div>
        <Field label="Flash Attention" hint="Экономит видеопамять на буферах внимания и ускоряет длинный контекст. Нужен для квантования V-кэша.">
          <Select
            label="Flash Attention"
            value={value.flashAttention}
            onChange={(v) => set('flashAttention', v)}
            options={[
              { value: 'on', label: 'Вкл' },
              { value: 'auto', label: 'Авто' },
              { value: 'off', label: 'Выкл' }
            ]}
          />
        </Field>
        {!isExl3 && (
          <>
            <Field label="Потоки CPU" hint="Сколько потоков процессора считают слои, оставшиеся в RAM. 0 — по числу физических ядер.">
              <NumberInput value={value.cpuThreads} onChange={(v) => set('cpuThreads', Math.round(v))} min={0} max={256} />
            </Field>
            <Field label="Размер пакета оценки" hint="Сколько токенов промпта обрабатывается за раз (-b). Больше — быстрее чтение длинного промпта, но больше буферы.">
              <NumberInput value={value.evalBatchSize} onChange={(v) => set('evalBatchSize', Math.round(v))} min={32} max={16384} step={64} />
            </Field>
            <Field label="Физический размер пакета" hint="Размер микропакета на GPU (-ub). Влияет на буферы вычислений.">
              <NumberInput
                value={value.physicalBatchSize}
                onChange={(v) => set('physicalBatchSize', Math.round(Math.min(v, value.evalBatchSize)))}
                min={32}
                max={value.evalBatchSize}
                step={64}
              />
            </Field>
          </>
        )}
      </Section>

      <Section title="Кэш контекста">
        <Field label="Квантование K-кэша" hint="Сжатие ключей в KV-кэше. Q8_0 почти без потерь и вдвое меньше F16.">
          <div className="flex items-center gap-2">
            <Switch
              label="Квантование K-кэша"
              checked={value.kCacheType.enabled}
              onChange={(en) => set('kCacheType', { ...value.kCacheType, enabled: en })}
            />
            <Select
              label="Тип K-кэша"
              value={value.kCacheType.value}
              disabled={!value.kCacheType.enabled}
              onChange={(v) => set('kCacheType', { ...value.kCacheType, value: v })}
              options={KV_OPTIONS}
              className="max-w-none"
            />
          </div>
        </Field>
        <Field
          label="Квантование V-кэша"
          hint="Сжатие значений в KV-кэше. Работает только с Flash Attention."
          disabled={value.flashAttention === 'off'}
        >
          <div className="flex items-center gap-2">
            <Switch
              label="Квантование V-кэша"
              checked={value.vCacheType.enabled}
              onChange={(en) => set('vCacheType', { ...value.vCacheType, enabled: en })}
            />
            <Select
              label="Тип V-кэша"
              value={value.vCacheType.value}
              disabled={!value.vCacheType.enabled}
              onChange={(v) => set('vCacheType', { ...value.vCacheType, value: v })}
              options={KV_OPTIONS}
              className="max-w-none"
            />
          </div>
        </Field>
        {!isExl3 && (
          <>
            <Field label="Одновременные запросы" hint="Сколько диалогов движок обслуживает параллельно. Для чата достаточно 1.">
              <NumberInput value={value.maxParallel} onChange={(v) => set('maxParallel', Math.round(v))} min={1} max={64} />
            </Field>
            <Field label="Общий KV-кэш" hint="Один кэш на все параллельные запросы (--kv-unified).">
              <Switch checked={value.unifiedKvCache} onChange={(v) => set('unifiedKvCache', v)} label="Общий KV-кэш" />
            </Field>
          </>
        )}
      </Section>

      <Section title="Дополнительно" defaultOpen={false}>
        {!isExl3 && (
          <>
            <Field label="Хранить модель в памяти" hint="mlock: запрещает Windows выгружать веса в файл подкачки.">
              <Switch checked={value.keepModelInMemory} onChange={(v) => set('keepModelInMemory', v)} label="mlock" />
            </Field>
            <Field label="Использовать mmap()" hint="Отображать файл модели в память вместо копирования. Ускоряет загрузку.">
              <Switch checked={value.tryMmap} onChange={(v) => set('tryMmap', v)} label="mmap" />
            </Field>
          </>
        )}
        <ToggleNumberField
          label="Основа частоты RoPE"
          hint="Переопределить rope_freq_base. Обычно не нужно."
          value={value.ropeFrequencyBase}
          onChange={(v) => set('ropeFrequencyBase', v)}
          min={0}
          step={1000}
          offLabel="Авто"
        />
        <ToggleNumberField
          label="Масштаб частоты RoPE"
          hint="Переопределить rope_freq_scale (растяжение контекста). Обычно не нужно."
          value={value.ropeFrequencyScale}
          onChange={(v) => set('ropeFrequencyScale', v)}
          min={0}
          step={0.05}
          offLabel="Авто"
        />
        <ToggleNumberField
          label="Сид"
          hint="Фиксированный сид делает ответы воспроизводимыми."
          value={value.seed}
          onChange={(v) => set('seed', v)}
          min={-1}
          offLabel="Случайный"
        />
        {model?.isMoe && (
          <Field
            label="Число активных экспертов"
            hint={`Сколько экспертов MoE работает на каждый токен. 0 — как в модели (${model.arch?.nExpertsUsed ?? '?'}).`}
          >
            <NumberInput
              value={value.numExperts}
              onChange={(v) => set('numExperts', Math.round(v))}
              min={0}
              max={model.arch?.nExperts ?? 256}
            />
          </Field>
        )}
        <Field label="Свой шаблон чата (Jinja)" hint="Заменяет шаблон из файла модели." stacked>
          <div className="flex flex-col gap-1.5">
            <Switch
              checked={value.promptTemplate.enabled}
              onChange={(en) =>
                set('promptTemplate', {
                  enabled: en,
                  value: value.promptTemplate.value || model?.chatTemplate || ''
                })
              }
              label="Свой шаблон"
            />
            {value.promptTemplate.enabled && (
              <TextArea
                mono
                rows={6}
                value={value.promptTemplate.value}
                onChange={(v) => set('promptTemplate', { ...value.promptTemplate, value: v })}
              />
            )}
          </div>
        </Field>
      </Section>

      <Section title="Спекулятивное декодирование" defaultOpen={false}>
        <Field label="Включить" hint="Маленькая черновая модель предлагает токены, большая их проверяет. Ускоряет генерацию в 1,3–2 раза на коде и шаблонном тексте.">
          <Switch
            checked={value.speculative.enabled}
            onChange={(v) => set('speculative', { ...value.speculative, enabled: v })}
            label="Спекулятивное декодирование"
          />
        </Field>
        {value.speculative.enabled && (
          <>
            <Field label="Черновая модель" hint="Та же семья моделей, но в разы меньше (например 0.6B для 14B).">
              <Select
                label="Черновая модель"
                value={value.speculative.draftModelId}
                onChange={(v) => set('speculative', { ...value.speculative, draftModelId: v })}
                options={[
                  { value: '', label: draftCandidates.length ? 'Не выбрана' : 'Нет подходящих моделей' },
                  ...draftCandidates.map((m) => ({ value: m.id, label: `${m.name} ${m.quant}` }))
                ]}
              />
            </Field>
            <Field label="Макс. размер черновика">
              <NumberInput
                value={value.speculative.draftMax}
                onChange={(v) => set('speculative', { ...value.speculative, draftMax: Math.round(v) })}
                min={1}
                max={64}
              />
            </Field>
            <Field label="Мин. размер черновика">
              <NumberInput
                value={value.speculative.draftMin}
                onChange={(v) => set('speculative', { ...value.speculative, draftMin: Math.round(v) })}
                min={0}
                max={value.speculative.draftMax}
              />
            </Field>
            <Field label="Порог продолжения черновика" hint="Черновик обрывается, когда уверенность черновой модели ниже порога.">
              <NumberInput
                value={value.speculative.pMin}
                onChange={(v) => set('speculative', { ...value.speculative, pMin: v })}
                min={0}
                max={1}
                step={0.05}
              />
            </Field>
          </>
        )}
      </Section>

      <Section title="Аргументы движка" defaultOpen={false}>
        <Field
          label="Дополнительные аргументы"
          hint="Добавляются в конец командной строки движка как есть. Для опытных пользователей."
          stacked
        >
          <div className="flex flex-col gap-1.5">
            <Switch
              checked={value.extraArgs.enabled}
              onChange={(en) => set('extraArgs', { ...value.extraArgs, enabled: en })}
              label="Дополнительные аргументы"
            />
            {value.extraArgs.enabled && (
              <TextArea
                mono
                rows={2}
                placeholder="--no-warmup --cache-reuse 256"
                value={value.extraArgs.value}
                onChange={(v) => set('extraArgs', { ...value.extraArgs, value: v })}
              />
            )}
          </div>
        </Field>
      </Section>
    </div>
  )
}
