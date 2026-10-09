// Менеджер движков: выбор движка, план памяти, запуск/остановка llama-server, статус и IPC.
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import type { EngineId, LoadConfig } from '@shared/config'
import type { EngineStatus, HardwareInfo, LocalModel, MemoryActual, MemoryPlan } from '@shared/types'
import { emit, handle } from '../ipc'
import { logsDir, tmpDownloadsDir } from '../paths'
import { getSettings } from '../settings'
import { getHardwareInfo, shutdownHardware } from '../hardware'
import { getModel } from '../models/registry'
import { planMemory } from '../memory/planner'
import {
  registerRuntimesIpc,
  resolveRuntime,
  runtimeStore,
  setRuntimeInUseCheck,
  shutdownRuntimes,
  type ResolvedRuntime
} from '../runtimes/manager'
import { evaluateRuntime, recommendedRuntimeIds, type RuntimeCatalogEntry } from '../runtimes/catalog'
import { ENGINE_TITLES, EXL3_NOT_READY, getAdapter } from './adapters'
import { actualByDevice, type LogEvent } from './log-parser'
import { EngineError, EngineProcess, freePort, RING_SIZE } from './process'

export interface ActiveEngine {
  engine: EngineId
  /** http://127.0.0.1:PORT */
  baseUrl: string
  modelId: string
  contextLength: number
  vision: boolean
}

interface Session {
  proc: EngineProcess
  engine: EngineId
  runtimeId: string
  modelId: string
  contextLength: number
  vision: boolean
  /** Сколько VRAM (МиБ, по индексу GPU) и RAM занял движок — для предпросмотра плана «после выгрузки». */
  vramUsedMiB: Record<number, number>
  ramUsedMiB: number
  templateFile?: string
}

let status: EngineStatus = { state: 'idle' }
let session: Session | null = null
interface LoadingState {
  seq: number
  proc: EngineProcess | null
  abort: AbortController
  /** Завершается (без ошибок), когда попытка загрузки полностью отработала. */
  done: Promise<void>
}
let loading: LoadingState | null = null
let loadSeq = 0
let lastLines: string[] = []

// ---------- статус и журнал ----------

let statusTimer: NodeJS.Timeout | null = null
function setStatus(next: EngineStatus, throttle = false): void {
  status = next
  if (!throttle) {
    if (statusTimer) clearTimeout(statusTimer)
    statusTimer = null
    emit('engine:status', status)
    return
  }
  statusTimer ??= setTimeout(() => {
    statusTimer = null
    emit('engine:status', status)
  }, 200)
}

const logQueue: string[] = []
let logTimer: NodeJS.Timeout | null = null
function queueLog(line: string): void {
  logQueue.push(line)
  logTimer ??= setTimeout(() => {
    logTimer = null
    const batch = logQueue.splice(0)
    const MAX = 500
    if (batch.length > MAX) {
      const skipped = batch.length - MAX
      batch.splice(0, skipped, `[NeuroYouStudio] … пропущено строк: ${skipped}`)
    }
    for (const l of batch) emit('engine:log', l)
  }, 100)
}

export function activeEngine(): ActiveEngine | null {
  if (!session || status.state !== 'ready') return null
  return {
    engine: session.engine,
    baseUrl: session.proc.baseUrl,
    modelId: session.modelId,
    contextLength: session.contextLength,
    vision: session.vision
  }
}

export function engineStatus(): EngineStatus {
  return status
}

export function engineLogs(): string[] {
  return loading?.proc?.lines ?? session?.proc.lines ?? lastLines
}

// ---------- выбор движка ----------

const gib = (bytes: number): string => (bytes / 1024 ** 3).toFixed(1)

function gpuDeviceFor(entry: RuntimeCatalogEntry | undefined, hw: HardwareInfo): string | undefined {
  if (!hw.gpus.length && entry?.backend !== 'vulkan') return undefined
  if (!entry) return hw.gpus.length ? 'CUDA0' : undefined
  if (entry.backend === 'cuda') return 'CUDA0'
  if (entry.backend === 'vulkan') return 'Vulkan0'
  return undefined
}

function requireModel(modelId: string): LocalModel {
  const model = getModel(modelId)
  if (!model) throw new Error('Модель не найдена — обновите список моделей')
  if (model.error) throw new Error(`Модель повреждена или не поддерживается: ${model.error}`)
  return model
}

function safePlan(model: LocalModel, load: LoadConfig, hw: HardwareInfo, engine: EngineId): MemoryPlan {
  try {
    return planMemory(model, load, hw, engine)
  } catch (e) {
    throw new Error(`Не удалось рассчитать раскладку памяти: ${e instanceof Error ? e.message : String(e)}`, {
      cause: e
    })
  }
}

/** Движок по настройкам: явный выбор или auto (EXL3 → ExLlamaV3; GGUF → llama.cpp или ik_llama.cpp). */
async function chooseEngine(
  model: LocalModel,
  load: LoadConfig,
  hw: HardwareInfo
): Promise<{ engine: EngineId; plan: MemoryPlan }> {
  let choice = load.engine
  if (choice === 'auto' && model.format === 'gguf') choice = getSettings().defaultEngineGguf
  if (model.format === 'exl3') {
    if (choice !== 'auto' && choice !== 'exl3') throw new Error('Модель EXL3 запускается только движком ExLlamaV3')
    throw new Error(EXL3_NOT_READY)
  }
  if (choice === 'exl3') throw new Error('Модель GGUF нельзя запустить в ExLlamaV3 — выберите llama.cpp или ik_llama.cpp')
  if (choice === 'llamacpp' || choice === 'ikllama') {
    return { engine: choice, plan: safePlan(model, load, hw, choice) }
  }
  const plan = safePlan(model, load, hw, 'llamacpp')
  if (plan.fit === 'full') return { engine: 'llamacpp', plan }
  // Модель не влезает целиком в VRAM — ik_llama.cpp заметно быстрее при выгрузке в RAM.
  if (await resolveRuntime('ikllama')) return { engine: 'ikllama', plan: safePlan(model, load, hw, 'ikllama') }
  return { engine: 'llamacpp', plan }
}

function notInstalledError(engine: EngineId): Error {
  return new Error(`Движок ${ENGINE_TITLES[engine]} не установлен — откройте раздел «Движки»`)
}

function guardrailMessage(plan: MemoryPlan): string {
  return (
    `Модель не помещается в память: нужно ${gib(plan.vramBytes)} ГБ VRAM + ${gib(plan.ramBytes)} ГБ RAM, ` +
    `доступно ${gib(plan.vramAvailableBytes)} ГБ VRAM + ${gib(plan.ramAvailableBytes)} ГБ RAM. ` +
    'Уменьшите контекст, выберите квантование поменьше или отключите защиту в настройках.'
  )
}

async function writeTemplate(load: LoadConfig, port: number): Promise<string | undefined> {
  if (!load.promptTemplate.enabled || !load.promptTemplate.value.trim()) return undefined
  const file = join(tmpDownloadsDir(), `chat-template-${port}.jinja`)
  await fs.writeFile(file, load.promptTemplate.value, 'utf8')
  return file
}

function draftPath(load: LoadConfig): string | undefined {
  if (!load.speculative.enabled || !load.speculative.draftModelId) return undefined
  const draft = getModel(load.speculative.draftModelId)
  if (!draft) throw new Error('Черновая модель для спекулятивного декодирования не найдена')
  if (draft.format !== 'gguf') throw new Error('Черновая модель должна быть в формате GGUF')
  return draft.path
}

const sumCuda = (actual: MemoryActual | undefined, gpuIndex: number): number =>
  actual ? (actualByDevice(actual)[`CUDA${gpuIndex}`] ?? 0) : 0

/** Если буферы на GPU больше свободной VRAM — драйвер Windows молча уводит их в общую память (медленно). */
function spillWarning(actual: MemoryActual, before: HardwareInfo): string | null {
  for (const g of before.gpus) {
    const used = sumCuda(actual, g.index)
    // ~300 МиБ — контекст CUDA и кэши cuBLAS, которых нет в журнале.
    if (used > 0 && used + 300 > g.vramFreeMiB) {
      return (
        `Буферы на GPU (${Math.round(used)} МиБ) больше свободной видеопамяти (${g.vramFreeMiB} МиБ): ` +
        'драйвер вынес часть данных в общую память, генерация будет медленной. Уменьшите контекст или число слоёв на GPU.'
      )
    }
  }
  return null
}

// ---------- загрузка / выгрузка ----------

export async function loadModel(modelId: string, load: LoadConfig): Promise<EngineStatus> {
  const prev = loading
  const me: LoadingState = { seq: ++loadSeq, proc: null, abort: new AbortController(), done: Promise.resolve() }
  loading = me
  // Новая загрузка отменяет предыдущую и ждёт, пока та остановит свой процесс.
  if (prev) {
    prev.abort.abort()
    await prev.done
    if (me.abort.signal.aborted) throw new EngineError('Загрузка отменена', 'aborted')
  }
  const p = doLoad(me, modelId, load)
  me.done = p.then(
    () => undefined,
    () => undefined
  )
  return p
}

async function doLoad(me: LoadingState, modelId: string, load: LoadConfig): Promise<EngineStatus> {
  const stale = (): boolean => loadSeq !== me.seq || me.abort.signal.aborted
  const aborted = (): EngineError => new EngineError('Загрузка отменена', 'aborted')

  // Проверки до выгрузки текущей модели: при отказе она остаётся загруженной, статус не меняется.
  let draftModelPath: string | undefined
  let pre: { engine: EngineId; plan: MemoryPlan }
  try {
    const model = requireModel(modelId)
    pre = await chooseEngine(model, load, await hardwareWithoutCurrent())
    if (!(await resolveRuntime(pre.engine))) throw notInstalledError(pre.engine)
    const guard = getSettings().guardrails
    if (pre.plan.fit === 'none' && guard !== 'off') throw new Error(guardrailMessage(pre.plan))
    draftModelPath = draftPath(load)
  } catch (e) {
    if (loading === me) loading = null
    throw e
  }

  try {
    const model = requireModel(modelId)
    await unloadModel(true)
    if (stale()) throw aborted()

    const hw = await getHardwareInfo(true)
    const engine = pre.engine
    const plan = safePlan(model, load, hw, engine)
    const adapter = getAdapter(engine)
    const runtime = await resolveRuntime(engine)
    if (!runtime) throw notInstalledError(engine)

    const port = await freePort()
    const templateFile = await writeTemplate(load, port)
    const spec = adapter.buildLaunch({
      model,
      load,
      layout: plan.resolved,
      nLayers: plan.nLayers || model.arch?.nLayers || 0,
      port,
      runtimeDir: runtime.dir,
      serverExe: runtime.serverExe,
      threadsDefault: hw.cpuCores || hw.cpuThreads,
      gpuDevice: gpuDeviceFor(runtime.entry, hw),
      draftModelPath,
      templateFile
    })
    const finalPlan: MemoryPlan = { ...plan, args: spec.args, warnings: [...plan.warnings] }
    const vision = Boolean(model.vision && model.mmprojPath)
    const base: EngineStatus = {
      state: 'starting',
      engine,
      runtimeId: runtime.id,
      modelId,
      port,
      load,
      plan: finalPlan,
      contextLength: load.contextLength,
      vision,
      loadProgress: 0
    }
    setStatus(base)

    const parser = adapter.createLogParser()
    const date = new Date().toISOString().slice(0, 10)
    const onEvent = (ev: LogEvent): void => {
      if (stale()) return
      if (ev.type === 'progress') setStatus({ ...status, loadProgress: ev.value }, true)
      else if (ev.type === 'buffer') setStatus({ ...status, actual: structuredClone(parser.actual) }, true)
      else if (ev.type === 'context') setStatus({ ...status, contextLength: ev.nCtx }, true)
    }
    const proc: EngineProcess = new EngineProcess({
      spec,
      port,
      parser,
      healthcheck: adapter.healthcheck,
      logFile: join(logsDir(), `engine-${date}.log`),
      onLine: queueLog,
      onEvent,
      onExit: (code) => onProcessExit(proc, code)
    })
    me.proc = proc
    proc.start()
    setStatus({ ...base, state: 'loading' })

    try {
      await proc.waitReady(me.abort.signal)
      if (stale()) throw aborted()
    } catch (e) {
      await proc.stop()
      lastLines = proc.lines
      if (templateFile) await fs.rm(templateFile, { force: true }).catch(() => undefined)
      throw e
    }

    const actual = structuredClone(parser.actual)
    const after = await getHardwareInfo(true)
    const vramUsedMiB: Record<number, number> = {}
    for (const g of hw.gpus) {
      const delta = g.vramFreeMiB - (after.gpus.find((x) => x.index === g.index)?.vramFreeMiB ?? g.vramFreeMiB)
      vramUsedMiB[g.index] = Math.max(delta, sumCuda(actual, g.index))
    }
    const spill = spillWarning(actual, hw)
    if (spill) finalPlan.warnings.push(spill)

    session = {
      proc,
      engine,
      runtimeId: runtime.id,
      modelId,
      contextLength: status.contextLength ?? load.contextLength,
      vision,
      vramUsedMiB,
      ramUsedMiB: actualByDevice(actual)['CPU'] ?? 0,
      templateFile
    }
    if (loading === me) loading = null
    setStatus({ ...status, state: 'ready', actual, plan: finalPlan, loadProgress: 1, error: undefined })
    return status
  } catch (e) {
    if (loading === me) loading = null
    const msg = e instanceof Error ? e.message : String(e)
    if (!(e instanceof EngineError && e.code === 'aborted')) {
      setStatus({ ...status, state: 'error', error: msg, loadProgress: undefined })
    }
    throw e instanceof Error ? e : new Error(msg)
  }
}

/** Неожиданное завершение движка после загрузки. */
function onProcessExit(proc: EngineProcess, code: number | null): void {
  if (session?.proc !== proc) return
  lastLines = proc.lines
  const failure = proc.failure(`Движок неожиданно завершился (код ${code ?? '?'})`)
  const templateFile = session.templateFile
  session = null
  if (templateFile) void fs.rm(templateFile, { force: true })
  setStatus({ ...status, state: 'error', error: failure.message })
}

export async function unloadModel(silent = false): Promise<EngineStatus> {
  if (!silent && loading) {
    const cur = loading
    loadSeq++
    cur.abort.abort()
    await cur.done
  }
  const cur = session
  if (!cur) {
    if (!silent && status.state !== 'idle') setStatus({ state: 'idle' })
    return status
  }
  session = null
  setStatus({ ...status, state: 'stopping' })
  await cur.proc.stop()
  lastLines = cur.proc.lines
  if (cur.templateFile) await fs.rm(cur.templateFile, { force: true }).catch(() => undefined)
  setStatus({ state: 'idle' })
  return status
}

// ---------- предпросмотр плана ----------

/** Железо «как будто текущая модель выгружена»: возвращаем занятую ею память. */
async function hardwareWithoutCurrent(): Promise<HardwareInfo> {
  const hw = await getHardwareInfo(true)
  if (!session) return hw
  const s = session
  return {
    ...hw,
    gpus: hw.gpus.map((g) => ({
      ...g,
      vramFreeMiB: Math.min(g.vramTotalMiB, g.vramFreeMiB + (s.vramUsedMiB[g.index] ?? 0))
    })),
    ramFreeMiB: Math.min(hw.ramTotalMiB, hw.ramFreeMiB + s.ramUsedMiB)
  }
}

async function previewRuntime(engine: EngineId, hw: HardwareInfo): Promise<ResolvedRuntime | RuntimeCatalogEntry | null> {
  const installed = await resolveRuntime(engine)
  if (installed) return installed
  const store = runtimeStore()
  const rec = recommendedRuntimeIds(hw, store.catalog)
  return store.catalog.find((e) => e.engine === engine && rec.has(e.id) && evaluateRuntime(e, hw).compatible) ?? null
}

export async function previewPlan(modelId: string, load: LoadConfig): Promise<MemoryPlan> {
  const model = requireModel(modelId)
  const hw = await hardwareWithoutCurrent()
  const { engine, plan } = await chooseEngine(model, load, hw)
  const rt = await previewRuntime(engine, hw)
  const entry = rt ? ('entry' in rt ? rt.entry : rt) : undefined
  const spec = getAdapter(engine).buildLaunch({
    model,
    load,
    layout: plan.resolved,
    nLayers: plan.nLayers || model.arch?.nLayers || 0,
    port: session?.proc.port ?? 0,
    runtimeDir: rt && 'dir' in rt ? rt.dir : '',
    serverExe: rt?.serverExe ?? 'llama-server.exe',
    threadsDefault: hw.cpuCores || hw.cpuThreads,
    gpuDevice: gpuDeviceFor(entry, hw),
    draftModelPath: load.speculative.enabled ? getModel(load.speculative.draftModelId)?.path : undefined,
    templateFile: load.promptTemplate.enabled ? '<шаблон>' : undefined
  })
  const warnings = [...plan.warnings]
  if (!rt) warnings.push(notInstalledError(engine).message)
  return { ...plan, args: spec.args, warnings }
}

// ---------- IPC ----------

/** Регистрирует IPC engine:*, memory:plan, runtimes:*. */
export function registerEngineIpc(): void {
  setRuntimeInUseCheck((id) => session?.runtimeId === id || (loading !== null && status.runtimeId === id))
  registerRuntimesIpc()
  handle('engine:status', () => status)
  handle('engine:load', (modelId, load) => loadModel(modelId, load))
  handle('engine:unload', () => unloadModel())
  handle('engine:logs', () => engineLogs().slice(-RING_SIZE))
  handle('memory:plan', (modelId, load) => previewPlan(modelId, load))
}

export async function shutdownEngines(): Promise<void> {
  shutdownHardware()
  shutdownRuntimes()
  loading?.abort.abort()
  const procs = [session?.proc, loading?.proc].filter((p): p is EngineProcess => Boolean(p))
  session = null
  loading = null
  await Promise.allSettled(procs.map((p) => p.stop()))
}
