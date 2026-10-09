// Установка/удаление сборок движков на диск. Без electron: пути передаются снаружи.
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import extract from 'extract-zip'
import { installTabby } from './tabby-install'
import type { EngineId } from '@shared/config'
import type { HardwareInfo, RuntimeDescriptor, TaskProgress } from '@shared/types'
import { downloadFile } from './download'
import {
  RUNTIME_CATALOG,
  evaluateRuntime,
  recommendedRuntimeIds,
  type RuntimeCatalogEntry
} from './catalog'

export const MARKER_FILE = '.installed.json'

export interface InstalledMarker {
  id: string
  engine: EngineId
  version: string
  variant: string
  serverExe: string
  installedAt: number
  files: Array<{ name: string; sha256: string }>
}

export interface ResolvedRuntime {
  id: string
  engine: EngineId
  dir: string
  serverExe: string
  entry: RuntimeCatalogEntry
}

export interface RuntimeStoreOptions {
  runtimesDir: string
  tmpDir: string
  catalog?: RuntimeCatalogEntry[]
  platform?: NodeJS.Platform
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}

/** rename с повторами: на Windows антивирус ненадолго держит свежие файлы. */
async function renameRetry(from: string, to: string): Promise<void> {
  for (let i = 0; ; i++) {
    try {
      await fs.rename(from, to)
      return
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      if (i >= 10 || (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES')) throw e
      await new Promise((r) => setTimeout(r, 300 * (i + 1)))
    }
  }
}

async function rmRetry(p: string): Promise<void> {
  await fs.rm(p, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })
}

/** Переносит содержимое src в dst (с заменой файлов). */
async function mergeInto(src: string, dst: string): Promise<void> {
  await fs.mkdir(dst, { recursive: true })
  for (const ent of await fs.readdir(src, { withFileTypes: true })) {
    const from = join(src, ent.name)
    const to = join(dst, ent.name)
    if (ent.isDirectory() && (await exists(to))) {
      await mergeInto(from, to)
    } else {
      if (await exists(to)) await rmRetry(to)
      await renameRetry(from, to)
    }
  }
}

/** Распаковывает zip в dst; если внутри одна папка верхнего уровня — «сплющивает» её. */
export async function extractZipFlatten(zip: string, dst: string): Promise<void> {
  const tmp = `${dst}.x${Date.now().toString(36)}`
  await rmRetry(tmp)
  await fs.mkdir(tmp, { recursive: true })
  try {
    await extract(zip, { dir: tmp })
    let src = tmp
    const top = await fs.readdir(src, { withFileTypes: true })
    if (top.length === 1 && top[0]?.isDirectory()) src = join(tmp, top[0].name)
    await mergeInto(src, dst)
  } finally {
    await rmRetry(tmp)
  }
}

export class RuntimeStore {
  readonly runtimesDir: string
  readonly tmpDir: string
  readonly catalog: RuntimeCatalogEntry[]
  private readonly platform: NodeJS.Platform
  private readonly installing = new Map<string, Promise<void>>()

  constructor(opts: RuntimeStoreOptions) {
    this.runtimesDir = opts.runtimesDir
    this.tmpDir = opts.tmpDir
    this.catalog = opts.catalog ?? RUNTIME_CATALOG
    this.platform = opts.platform ?? process.platform
  }

  entry(id: string): RuntimeCatalogEntry | undefined {
    return this.catalog.find((e) => e.id === id)
  }

  dirOf(id: string): string {
    if (!/^[\w.-]+$/.test(id)) throw new Error(`Некорректный id сборки: ${id}`)
    return join(this.runtimesDir, id)
  }

  isInstalling(id: string): boolean {
    return this.installing.has(id)
  }

  /** Идущие установки (для ожидания при закрытии приложения). */
  pendingInstalls(): Array<Promise<void>> {
    return [...this.installing.values()]
  }

  async marker(id: string): Promise<InstalledMarker | null> {
    try {
      const m = JSON.parse(await fs.readFile(join(this.dirOf(id), MARKER_FILE), 'utf8')) as InstalledMarker
      if (!(await exists(join(this.dirOf(id), m.serverExe)))) return null
      return m
    } catch {
      return null
    }
  }

  async installedIds(): Promise<string[]> {
    const out: string[] = []
    for (const e of this.catalog) if (await this.marker(e.id)) out.push(e.id)
    return out
  }

  async list(hw: HardwareInfo): Promise<RuntimeDescriptor[]> {
    const rec = recommendedRuntimeIds(hw, this.catalog, this.platform)
    const out: RuntimeDescriptor[] = []
    for (const e of this.catalog) {
      const fit = evaluateRuntime(e, hw, this.platform)
      const installed = Boolean(await this.marker(e.id))
      out.push({
        id: e.id,
        engine: e.engine,
        title: e.title,
        version: e.version,
        variant: e.variant,
        description: fit.jit
          ? `${e.description} Первый запуск может занять несколько минут (JIT-компиляция под вашу видеокарту).`
          : e.description,
        downloadBytes: e.estimatedBytes ?? e.files.reduce((s, f) => s + f.size, 0),
        installed,
        installedPath: installed ? this.dirOf(e.id) : undefined,
        compatible: fit.compatible,
        incompatibleReason: fit.reason,
        recommended: rec.has(e.id)
      })
    }
    return out
  }

  /** Установка: скачивание с докачкой, проверка SHA256, распаковка, маркер. */
  install(id: string, onProgress: (p: TaskProgress) => void, signal?: AbortSignal): Promise<void> {
    const running = this.installing.get(id)
    if (running) return running
    const p = this.doInstall(id, onProgress, signal).finally(() => this.installing.delete(id))
    this.installing.set(id, p)
    return p
  }

  private async doInstall(id: string, onProgress: (p: TaskProgress) => void, signal?: AbortSignal): Promise<void> {
    const entry = this.entry(id)
    if (!entry) throw new Error(`Неизвестная сборка движка: ${id}`)
    if (entry.installer === 'tabby') return this.installTabbyRuntime(entry, onProgress, signal)
    const totalBytes = entry.files.reduce((s, f) => s + f.size, 0)
    const base: TaskProgress = { id, title: entry.title, phase: 'Загрузка', receivedBytes: 0, totalBytes, done: false }
    onProgress(base)

    await fs.mkdir(this.tmpDir, { recursive: true })
    let doneBytes = 0
    const zips: string[] = []
    for (const file of entry.files) {
      const dest = join(this.tmpDir, file.name)
      await downloadFile({
        url: file.url,
        dest,
        sha256: file.sha256,
        size: file.size,
        signal,
        onProgress: (rec) =>
          onProgress({ ...base, phase: `Загрузка ${file.name}`, receivedBytes: doneBytes + rec })
      })
      doneBytes += file.size
      zips.push(dest)
    }

    onProgress({ ...base, phase: 'Распаковка', receivedBytes: totalBytes })
    const dir = this.dirOf(id)
    const staging = `${dir}.staging`
    await rmRetry(staging)
    for (const zip of zips) {
      signal?.throwIfAborted()
      await extractZipFlatten(zip, staging)
    }
    if (!(await exists(join(staging, entry.serverExe)))) {
      await rmRetry(staging)
      throw new Error(`В архиве нет ${entry.serverExe} — сборка повреждена или изменился её формат`)
    }
    const marker: InstalledMarker = {
      id,
      engine: entry.engine,
      version: entry.version,
      variant: entry.variant,
      serverExe: entry.serverExe,
      installedAt: Date.now(),
      files: entry.files.map((f) => ({ name: f.name, sha256: f.sha256 }))
    }
    await fs.writeFile(join(staging, MARKER_FILE), JSON.stringify(marker, null, 2), 'utf8')
    await rmRetry(dir)
    await renameRetry(staging, dir)

    // Архивы больше не нужны (сотни МБ).
    for (const zip of zips) await fs.rm(zip, { force: true }).catch(() => undefined)
    onProgress({ ...base, phase: 'Готово', receivedBytes: totalBytes, done: true })
  }

  /**
   * ExLlamaV3: Python-окружение ставится сразу в итоговую папку — venv хранит абсолютные пути,
   * переименование staging → dir его сломало бы. Повторный запуск доустанавливает недостающее.
   */
  private async installTabbyRuntime(
    entry: RuntimeCatalogEntry,
    onProgress: (p: TaskProgress) => void,
    signal?: AbortSignal
  ): Promise<void> {
    const totalBytes = entry.estimatedBytes ?? 1
    const base: TaskProgress = { id: entry.id, title: entry.title, phase: 'Подготовка', receivedBytes: 0, totalBytes, done: false }
    onProgress(base)
    const dir = this.dirOf(entry.id)
    await fs.mkdir(this.tmpDir, { recursive: true })
    await fs.rm(join(dir, MARKER_FILE), { force: true })
    await installTabby(
      dir,
      this.tmpDir,
      (s) => onProgress({ ...base, phase: s.phase, receivedBytes: Math.round(s.fraction * totalBytes) }),
      signal
    )
    const marker: InstalledMarker = {
      id: entry.id,
      engine: entry.engine,
      version: entry.version,
      variant: entry.variant,
      serverExe: entry.serverExe,
      installedAt: Date.now(),
      files: []
    }
    await fs.writeFile(join(dir, MARKER_FILE), JSON.stringify(marker, null, 2), 'utf8')
    onProgress({ ...base, phase: 'Готово', receivedBytes: totalBytes, done: true })
  }

  async remove(id: string): Promise<void> {
    if (this.installing.has(id)) throw new Error('Сборка сейчас устанавливается')
    // Сначала маркер: если удаление прервётся на занятом файле, полусломанная сборка не будет считаться установленной.
    await fs.rm(join(this.dirOf(id), MARKER_FILE), { force: true })
    await rmRetry(this.dirOf(id))
  }

  /**
   * Сборка для запуска движка: выбранная (если установлена и совместима),
   * иначе лучшая установленная совместимая, иначе null.
   */
  async resolve(engine: EngineId, hw: HardwareInfo, selectedId?: string): Promise<ResolvedRuntime | null> {
    const candidates: Array<{ entry: RuntimeCatalogEntry; marker: InstalledMarker; score: number }> = []
    for (const e of this.catalog) {
      if (e.engine !== engine) continue
      const marker = await this.marker(e.id)
      if (!marker) continue
      const fit = evaluateRuntime(e, hw, this.platform)
      if (!fit.compatible) continue
      candidates.push({ entry: e, marker, score: fit.score })
    }
    const pick =
      candidates.find((c) => c.entry.id === selectedId) ?? candidates.sort((a, b) => b.score - a.score)[0]
    if (!pick) return null
    const dir = this.dirOf(pick.entry.id)
    return { id: pick.entry.id, engine, dir, serverExe: join(dir, pick.marker.serverExe), entry: pick.entry }
  }
}
