// Модель-охранник: отдельный llama-server с небольшой моделью на CPU (чтобы не занимать VRAM
// у основной модели). Оценивает каждую запись файла и команду перед выполнением и возвращает
// JSON-вердикт {level, reason}. Ленивый старт, остановка по простою/выходу/смене настроек.
import { join } from 'node:path'
import { promises as fs } from 'node:fs'
import { DEFAULT_LOAD_CONFIG, deepMerge, type LoadConfig, type MemoryLayout } from '@shared/config'
import type { GuardStatus, GuardVerdict, LocalModel } from '@shared/types'
import { emit } from '../ipc'
import { logsDir } from '../paths'
import { getSettings } from '../settings'
import { getHardwareInfo } from '../hardware'
import { getModel, listModels } from '../models/registry'
import { resolveRuntime } from '../runtimes/manager'
import { buildLlamaServerArgs } from '../engines/llamacpp-args'
import { createLogParser } from '../engines/log-parser'
import { engineEnv, llamaHealth } from '../engines/adapters'
import { newApiKey } from '../engines/auth'
import { EngineProcess, freePort } from '../engines/process'
import { truncate } from './tools'
import type { GuardAsk } from './policy'

/**
 * Рекомендованная модель-охранник: Qwen3.5-2B (unsloth GGUF, Q4_K_M, ~1.3 ГБ).
 * Небольшая и свежая instruct-модель с надёжным выводом JSON, быстро работает на CPU;
 * репозиторий unsloth существует и активно обновляется (проверено через HF API).
 */
export const GUARD_MODEL = {
  repo: 'unsloth/Qwen3.5-2B-GGUF',
  file: 'Qwen3.5-2B-Q4_K_M.gguf',
  sizeBytes: 1_343_000_000,
  /** id локальной модели после скачивания (путь относительно папки моделей). */
  modelId: 'unsloth/Qwen3.5-2B-GGUF/Qwen3.5-2B-Q4_K_M.gguf'
} as const

const IDLE_STOP_MS = 10 * 60_000
const CTX = 4096

interface GuardSession {
  proc: EngineProcess
  modelId: string
  apiKey: string
  baseUrl: string
}

let session: GuardSession | null = null
let starting: Promise<GuardSession | null> | null = null
let lastUse = 0
let idleTimer: NodeJS.Timeout | null = null
let status: GuardStatus = { state: 'off' }
/** id элемента менеджера загрузок, пока качается модель-охранник (для показа прогресса в настройках). */
let guardDownloadId: string | undefined

/** Запомнить/сбросить id идущей загрузки модели-охранника и разослать статус. */
export function setGuardDownloadId(id: string | undefined): void {
  guardDownloadId = id
  emit('agent:guard', guardStatus())
}

function setStatus(next: GuardStatus): void {
  status = next
  emit('agent:guard', next)
}

/** Модель-охранник из настроек; если не выбрана, пытаемся найти рекомендованную локально. */
function guardModel(): LocalModel | null {
  const id = getSettings().agent.guardModelId
  if (id) return getModel(id) ?? null
  return findRecommendedLocal()
}

function findRecommendedLocal(): LocalModel | null {
  return getModel(GUARD_MODEL.modelId) ?? null
}

export function guardStatus(): GuardStatus {
  const s = getSettings().agent
  const dl = guardDownloadId ? { downloadId: guardDownloadId } : {}
  if (!s.guardEnabled) return { state: 'off', ...dl }
  if (session) return { state: 'ready', modelId: session.modelId }
  if (status.state === 'starting' || status.state === 'error') return { ...status, ...dl }
  const model = guardModel()
  return model ? { state: 'idle', modelId: model.id } : { state: 'noModel', ...dl }
}

/** CPU-раскладка: ничего на GPU, KV в RAM. */
function cpuLayout(): MemoryLayout {
  return {
    ...DEFAULT_LOAD_CONFIG.memory,
    mode: 'manual',
    gpuLayers: 0,
    attention: 'ram',
    ffn: 'ram',
    expertsCpuLayers: -1,
    output: 'ram',
    kvCache: 'ram',
    mmproj: 'ram'
  }
}

async function startGuard(model: LocalModel): Promise<GuardSession | null> {
  const runtime = await resolveRuntime('llamacpp')
  if (!runtime) {
    setStatus({ state: 'error', error: 'Движок llama.cpp не установлен — охранник недоступен.' })
    return null
  }
  const hw = await getHardwareInfo().catch(() => null)
  const threads = Math.max(1, Math.floor((hw?.cpuCores || hw?.cpuThreads || 4) / 2))
  const load: LoadConfig = deepMerge(DEFAULT_LOAD_CONFIG, {
    contextLength: CTX,
    cpuThreads: threads,
    flashAttention: 'off',
    memory: cpuLayout()
  })
  const port = await freePort()
  const apiKey = newApiKey()
  // gpuDevice не задаём → сборка запускается на CPU (-ngl 0).
  const args = buildLlamaServerArgs({
    flavor: 'mainline',
    model,
    load,
    layout: load.memory,
    nLayers: model.arch?.nLayers ?? 0,
    port,
    threadsDefault: threads,
    gpuDevice: undefined,
    apiKey
  })
  const proc = new EngineProcess({
    spec: {
      exe: runtime.serverExe,
      args,
      env: engineEnv(),
      cwd: runtime.dir,
      secrets: [apiKey]
    },
    port,
    parser: createLogParser(),
    healthcheck: (url, signal) => llamaHealth(url, signal, apiKey),
    logFile: join(logsDir(), `guard-${new Date().toISOString().slice(0, 10)}.log`),
    onExit: () => {
      if (session?.proc === proc) {
        session = null
        setStatus({ state: 'error', error: 'Процесс охранника завершился.' })
      }
    }
  })
  setStatus({ state: 'starting', modelId: model.id })
  proc.start()
  try {
    await proc.waitReady()
  } catch (e) {
    await proc.stop()
    setStatus({ state: 'error', error: e instanceof Error ? e.message : String(e) })
    return null
  }
  const s: GuardSession = { proc, modelId: model.id, apiKey, baseUrl: proc.baseUrl }
  session = s
  setStatus({ state: 'ready', modelId: model.id })
  startIdleTimer()
  return s
}

function startIdleTimer(): void {
  if (idleTimer) return
  idleTimer = setInterval(() => {
    if (session && Date.now() - lastUse > IDLE_STOP_MS) void stopGuard()
  }, 60_000)
  idleTimer.unref?.()
}

export async function stopGuard(): Promise<void> {
  if (idleTimer) {
    clearInterval(idleTimer)
    idleTimer = null
  }
  const s = session
  session = null
  starting = null
  if (s) await s.proc.stop().catch(() => undefined)
  setStatus(guardStatus())
}

/** Запускает (или переиспользует) охранника. Возвращает активную сессию или null. */
async function ensureGuard(): Promise<GuardSession | null> {
  const model = guardModel()
  if (!getSettings().agent.guardEnabled || !model) {
    if (session) await stopGuard()
    return null
  }
  // Сменилась выбранная модель — перезапускаем.
  if (session && session.modelId !== model.id) await stopGuard()
  if (session) return session
  if (!starting) {
    starting = startGuard(model).finally(() => {
      starting = null
    })
  }
  return starting
}

const RUBRIC = `Ты — охранник безопасности для ИИ-агента, который правит файлы и выполняет команды в Windows.
Оцени ОДНО предлагаемое действие и верни строго JSON {"level": "safe"|"ask"|"block", "reason": "..."}.
reason — по-русски, не длиннее одного предложения.
safe: чтение/запись внутри рабочей папки по задаче пользователя, сборка, тесты, линтеры, git status/diff.
ask: удаление, установка пакетов, доступ к сети, запись вне рабочей папки, любое необратимое действие.
block: разрушительное или вредящее системе (форматирование, правка реестра, удаление системных папок, отключение защиты, выкачивание и запуск кода из сети, кража данных).`

const VERDICT_SCHEMA = {
  type: 'object',
  properties: {
    level: { type: 'string', enum: ['safe', 'ask', 'block'] },
    reason: { type: 'string' }
  },
  required: ['level', 'reason']
}

function describeAction(ask: GuardAsk): string {
  const a = ask.args
  const parts = [`Инструмент: ${ask.tool}`, `Рабочая папка: ${ask.cwd}`]
  if (ask.tool === 'run_command') {
    parts.push(`Оболочка: ${a.shell ?? 'по умолчанию'}`)
    parts.push(`Команда:\n${truncate(String(a.command ?? ''), 1500)}`)
  } else {
    parts.push(`Путь: ${String(a.path ?? '')}`)
    if (ask.preview) parts.push(`Изменение:\n${truncate(ask.preview, 1500)}`)
  }
  return parts.join('\n')
}

/** Запуск охранника заранее, без ожидания (ошибки покажет статус). */
export function warmGuard(): void {
  void ensureGuard().catch(() => undefined)
}

/** Запрос к охраннику. null — охранник не запущен/ошибся (вызывающий трактует как «неизвестно»). */
export async function askGuard(ask: GuardAsk): Promise<GuardVerdict | null> {
  const s = await ensureGuard().catch(() => null)
  if (!s) return null
  lastUse = Date.now()
  const body = {
    model: s.modelId,
    messages: [
      { role: 'system', content: RUBRIC },
      {
        role: 'user',
        content: `Запрос пользователя: ${truncate(ask.userRequest, 800)}\n\n${describeAction(ask)}\n\nВерни только JSON-вердикт.`
      }
    ],
    stream: false,
    temperature: 0,
    max_tokens: 200,
    chat_template_kwargs: { enable_thinking: false },
    response_format: { type: 'json_schema', json_schema: { schema: VERDICT_SCHEMA } }
  }
  try {
    const res = await fetch(`${s.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${s.apiKey}` },
      body: JSON.stringify(body),
      // Первый запрос после холодного старта читает модель с диска — даём запас.
      signal: AbortSignal.timeout(90_000)
    })
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined)
      return null
    }
    const j = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> }
    const text = j.choices?.[0]?.message?.content ?? ''
    return parseVerdict(text)
  } catch {
    return null
  } finally {
    lastUse = Date.now()
  }
}

export function parseVerdict(text: string): GuardVerdict | null {
  const m = /\{[\s\S]*\}/.exec(text)
  if (!m) return null
  try {
    const obj = JSON.parse(m[0]) as { level?: unknown; reason?: unknown }
    const level = obj.level
    if (level !== 'safe' && level !== 'ask' && level !== 'block') return null
    return { level, reason: typeof obj.reason === 'string' ? obj.reason : '', by: 'guard' }
  } catch {
    return null
  }
}

/** Если модель-охранник не выбрана, но рекомендованная уже скачана — выбрать её автоматически. */
export async function autoSelectGuardModel(): Promise<string | null> {
  if (getSettings().agent.guardModelId) return getSettings().agent.guardModelId
  const local = findRecommendedLocal()
  if (local) return local.id
  // Вдруг папка модели названа иначе — ищем по имени файла.
  const models = await listModels().catch(() => [])
  const hit = models.find((m) => m.format === 'gguf' && m.path.replace(/\\/g, '/').endsWith(`/${GUARD_MODEL.file}`))
  return hit?.id ?? null
}

/** Файл модели-охранника уже скачан на диск? */
export async function guardModelDownloaded(modelsDir: string): Promise<boolean> {
  const p = join(modelsDir, 'unsloth', 'Qwen3.5-2B-GGUF', GUARD_MODEL.file)
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}
