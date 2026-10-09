import { create } from 'zustand'
import type { DeepPartial, LoadConfig } from '@shared/config'
import type {
  AppSettings,
  DownloadItem,
  EngineStatus,
  HardwareInfo,
  HardwareLive,
  LocalModel,
  Preset,
  RuntimeDescriptor,
  TaskProgress
} from '@shared/types'
import { call, subscribe } from '@/lib/api'

// ---------- Настройки ----------

interface SettingsState {
  settings: AppSettings | null
  update: (patch: DeepPartial<AppSettings>) => Promise<void>
}

export const useSettings = create<SettingsState>((set) => ({
  settings: null,
  update: async (patch) => set({ settings: await call('settings:update', patch) })
}))

// ---------- Железо ----------

interface HardwareState {
  info: HardwareInfo | null
  live: HardwareLive | null
}

export const useHardware = create<HardwareState>(() => ({ info: null, live: null }))

// ---------- Движок ----------

interface EngineStore {
  status: EngineStatus
  logs: string[]
  /** Модель, выбранная в панели загрузки (ещё не обязательно загружена). */
  selectedModelId: string | null
  /** Черновик настроек загрузки для выбранной модели. */
  draftLoad: LoadConfig | null
  setSelected: (id: string | null) => void
  setDraftLoad: (l: LoadConfig) => void
  load: () => Promise<void>
  unload: () => Promise<void>
}

const LOG_LIMIT = 3000

export const useEngine = create<EngineStore>((set, get) => ({
  status: { state: 'idle' },
  logs: [],
  selectedModelId: null,
  draftLoad: null,
  setSelected: (id) => set({ selectedModelId: id }),
  setDraftLoad: (l) => set({ draftLoad: l }),
  load: async () => {
    const { selectedModelId, draftLoad } = get()
    if (!selectedModelId || !draftLoad) return
    set({ status: await call('engine:load', selectedModelId, draftLoad) })
  },
  unload: async () => set({ status: await call('engine:unload') })
}))

// ---------- Модели ----------

interface ModelsState {
  models: LocalModel[]
  loading: boolean
  refresh: (rescan?: boolean) => Promise<void>
}

export const useModels = create<ModelsState>((set) => ({
  models: [],
  loading: false,
  refresh: async (rescan = false) => {
    set({ loading: true })
    try {
      set({ models: await call('models:list', rescan) })
    } finally {
      set({ loading: false })
    }
  }
}))

// ---------- Пресеты ----------

interface PresetsState {
  presets: Preset[]
  refresh: () => Promise<void>
  save: (p: Preset) => Promise<void>
  remove: (id: string) => Promise<void>
}

export const usePresets = create<PresetsState>((set) => ({
  presets: [],
  refresh: async () => set({ presets: await call('presets:list') }),
  save: async (p) => set({ presets: await call('presets:save', p) }),
  remove: async (id) => set({ presets: await call('presets:delete', id) })
}))

// ---------- Загрузки и рантаймы ----------

interface DownloadsState {
  items: DownloadItem[]
}
export const useDownloads = create<DownloadsState>(() => ({ items: [] }))

interface RuntimesState {
  runtimes: RuntimeDescriptor[]
  progress: Record<string, TaskProgress>
  refresh: () => Promise<void>
}
export const useRuntimes = create<RuntimesState>((set) => ({
  runtimes: [],
  progress: {},
  refresh: async () => set({ runtimes: await call('runtimes:list') })
}))

// ---------- Подписки на события main-процесса ----------

let started = false

export async function initStores(): Promise<void> {
  if (started) return
  started = true

  subscribe('settings:changed', (s) => useSettings.setState({ settings: s }))
  subscribe('hardware:live', (live) => useHardware.setState({ live }))
  subscribe('engine:status', (status) => useEngine.setState({ status }))
  subscribe('engine:log', (line) =>
    useEngine.setState((s) => {
      const logs = s.logs.length >= LOG_LIMIT ? s.logs.slice(-LOG_LIMIT + 500) : s.logs.slice()
      logs.push(line)
      return { logs }
    })
  )
  subscribe('models:changed', (models) => useModels.setState({ models }))
  subscribe('downloads:update', (items) => useDownloads.setState({ items }))
  subscribe('runtimes:progress', (p) => {
    useRuntimes.setState((s) => ({ progress: { ...s.progress, [p.id]: p } }))
    if (p.done) void useRuntimes.getState().refresh()
  })

  const [settings, info, status, logs] = await Promise.all([
    call('settings:get'),
    call('hardware:get'),
    call('engine:status'),
    call('engine:logs')
  ])
  useSettings.setState({ settings })
  useHardware.setState({ info })
  useEngine.setState({ status, logs, selectedModelId: status.modelId ?? settings.lastModelId ?? null })
  applyAppearance(settings)
  subscribe('settings:changed', applyAppearance)

  await Promise.allSettled([
    useModels.getState().refresh(true),
    usePresets.getState().refresh(),
    useRuntimes.getState().refresh(),
    call('downloads:list').then((items) => useDownloads.setState({ items }))
  ])
}

function applyAppearance(s: AppSettings): void {
  const root = document.documentElement
  const theme =
    s.theme === 'auto' ? (window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark') : s.theme
  root.dataset.theme = theme
  root.dataset.font = s.fontSize
}
