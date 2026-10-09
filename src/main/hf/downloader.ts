// Очередь загрузок моделей: пауза/продолжение/отмена, скорость, сохранение состояния между запусками.
import { promises as fs } from 'node:fs'
import { dirname, parse as parsePath } from 'node:path'
import type { ModelFormat } from '@shared/config'
import type { DownloadItem } from '@shared/types'
import { newId } from '../util/id'
import { readJson, writeJson } from '../util/json-file'
import { HF_BASE_URL, HfError, resolveUrl } from './client'
import { formatSize } from './fit'
import { fileTarget, modelDir, optionTargetPath, splitRepoId, type RichOption } from './options'
import { partPath, toHfError, transferFile, type TransferOptions, type TransferStatus } from './transfer'

export const MAX_CONCURRENT_DOWNLOADS = 1
const HISTORY_LIMIT = 100
const SPEED_SAMPLE_MS = 500
const DISK_RESERVE_BYTES = 256 * 1024 * 1024

type State = DownloadItem['state']

export interface PlannedFile {
  path: string
  size: number
  sha256?: string
  target: string
}

export interface DownloadPlan {
  repo: string
  format: ModelFormat
  optionKey: string
  mmprojKey?: string
  title: string
  /** Ветка (для имени папки EXL3). */
  revision: string
  /** Что подставлять в URL: коммит, если известен, иначе ветка. */
  urlRevision: string
  targetPath: string
  /** Папка модели — удаляется при отмене, если опустела. */
  modelDir: string
  files: PlannedFile[]
}

interface FileRecord extends PlannedFile {
  done: boolean
  /** Файл уже был на диске до загрузки — при отмене не удаляем. */
  preexisting?: boolean
}

export interface DownloadRecord extends Omit<DownloadPlan, 'files'> {
  id: string
  state: State
  error?: string
  createdAt: number
  finishedAt?: number
  files: FileRecord[]
}

interface Runtime {
  bytes: number[]
  phase: string
  speed: number
  sampleBytes: number
  sampleAt: number
  controller?: AbortController
  running?: Promise<void>
}

export interface DownloadManagerOptions {
  /** <userData>/downloads.json */
  stateFile: string
  getToken?: () => Promise<string | null> | string | null
  baseUrl?: string
  onUpdate?: (items: DownloadItem[]) => void
  onItemDone?: (item: DownloadItem) => void | Promise<void>
  maxConcurrent?: number
  /** Минимальный интервал событий downloads:update (≤ 4/с). */
  emitIntervalMs?: number
  /** Период замера скорости. */
  speedSampleMs?: number
  transfer?: Pick<TransferOptions, 'stallTimeoutMs' | 'retryAttempts' | 'retryBaseDelayMs' | 'fetchImpl'>
  /** Свободное место на диске (байт) или null, если неизвестно. */
  diskFree?: (dir: string) => Promise<number | null>
  diskReserveBytes?: number
}

/** Что и куда качать для выбранного варианта (+ mmproj в ту же папку). */
export function planDownload(
  modelsDir: string,
  repoId: string,
  format: ModelFormat,
  option: RichOption,
  mmproj?: RichOption
): DownloadPlan {
  const seen = new Set<string>()
  const files: PlannedFile[] = []
  for (const f of [...option.files, ...(mmproj?.files ?? [])]) {
    const target = fileTarget(modelsDir, repoId, format, option.revision, f.path)
    if (seen.has(target.toLowerCase())) continue
    seen.add(target.toLowerCase())
    files.push({ path: f.path, size: f.size, ...(f.sha256 ? { sha256: f.sha256 } : {}), target })
  }
  const { name } = splitRepoId(repoId)
  return {
    repo: repoId,
    format,
    optionKey: option.key,
    ...(mmproj ? { mmprojKey: mmproj.key } : {}),
    title: `${name} · ${option.quant || option.label}${mmproj ? ' + mmproj' : ''}`,
    revision: option.revision,
    urlRevision: option.commit ?? option.revision,
    targetPath: optionTargetPath(modelsDir, repoId, format, option),
    modelDir: modelDir(modelsDir, repoId, format, option.revision),
    files
  }
}

async function statSize(p: string): Promise<number | null> {
  try {
    const st = await fs.stat(p)
    return st.isFile() ? st.size : null
  } catch {
    return null
  }
}

async function existingAncestor(p: string): Promise<string> {
  let cur = p
  for (;;) {
    try {
      await fs.stat(cur)
      return cur
    } catch {
      const up = dirname(cur)
      if (up === cur) return cur
      cur = up
    }
  }
}

async function defaultDiskFree(dir: string): Promise<number | null> {
  try {
    const s = await fs.statfs(dir)
    return Number(s.bavail) * Number(s.bsize)
  } catch {
    return null
  }
}

const STATES: State[] = ['queued', 'downloading', 'paused', 'done', 'error', 'canceled']
const FINISHED: State[] = ['done', 'error', 'canceled']

const PHASE: Record<State, string> = {
  queued: 'В очереди',
  downloading: 'Загрузка',
  paused: 'Пауза',
  done: 'Готово',
  error: 'Ошибка',
  canceled: 'Отменено'
}

function sanitizeRecord(raw: unknown): DownloadRecord | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Partial<DownloadRecord>
  if (typeof r.id !== 'string' || typeof r.repo !== 'string' || !Array.isArray(r.files)) return null
  if (!STATES.includes(r.state as State)) return null
  const files = r.files.filter(
    (f): f is FileRecord =>
      Boolean(f) && typeof f.path === 'string' && typeof f.target === 'string' && typeof f.size === 'number'
  )
  if (!files.length) return null
  return {
    id: r.id,
    repo: r.repo,
    format: r.format === 'exl3' ? 'exl3' : 'gguf',
    optionKey: String(r.optionKey ?? ''),
    ...(r.mmprojKey ? { mmprojKey: String(r.mmprojKey) } : {}),
    title: String(r.title ?? r.repo),
    revision: String(r.revision ?? 'main'),
    urlRevision: String(r.urlRevision ?? r.revision ?? 'main'),
    targetPath: String(r.targetPath ?? files[0]?.target ?? ''),
    modelDir: String(r.modelDir ?? dirname(files[0]?.target ?? '')),
    state: r.state as State,
    ...(r.error ? { error: String(r.error) } : {}),
    createdAt: Number(r.createdAt) || Date.now(),
    ...(r.finishedAt ? { finishedAt: Number(r.finishedAt) } : {}),
    files: files.map((f) => ({ ...f, done: Boolean(f.done), ...(f.preexisting ? { preexisting: true } : {}) }))
  }
}

export class DownloadManager {
  private records: DownloadRecord[] = []
  private readonly rt = new Map<string, Runtime>()
  private readonly opts: DownloadManagerOptions
  private readonly baseUrl: string
  private emitTimer: NodeJS.Timeout | undefined
  private lastEmit = 0
  private speedTimer: NodeJS.Timeout | undefined
  private persistTimer: NodeJS.Timeout | undefined
  private persistChain: Promise<void> = Promise.resolve()
  private closed = false

  constructor(opts: DownloadManagerOptions) {
    this.opts = opts
    this.baseUrl = (opts.baseUrl ?? HF_BASE_URL).replace(/\/+$/, '')
  }

  /** Восстанавливает очередь; незавершённые загрузки — на паузе. */
  async init(): Promise<void> {
    const data = await readJson<{ items?: unknown[] }>(this.opts.stateFile, {})
    for (const raw of Array.isArray(data.items) ? data.items : []) {
      const rec = sanitizeRecord(raw)
      if (!rec || this.records.some((r) => r.id === rec.id)) continue
      if (rec.state === 'downloading' || rec.state === 'queued') rec.state = 'paused'
      this.records.push(rec)
    }
    await Promise.all(this.records.map((r) => this.refreshBytes(r)))
    this.notify()
  }

  list(): DownloadItem[] {
    return this.records.map((r) => this.toItem(r))
  }

  get(id: string): DownloadItem | undefined {
    const r = this.records.find((x) => x.id === id)
    return r ? this.toItem(r) : undefined
  }

  /** Ставит вариант в очередь. Повторный запуск того же варианта продолжает существующую загрузку. */
  start(plan: DownloadPlan): DownloadItem {
    if (this.closed) throw new HfError('Приложение завершается.', 'input')
    if (!plan.files.length) throw new HfError('В выбранном варианте нет файлов.', 'input')
    const same = this.records.find(
      (r) =>
        r.repo === plan.repo &&
        r.optionKey === plan.optionKey &&
        (r.mmprojKey ?? '') === (plan.mmprojKey ?? '') &&
        r.format === plan.format &&
        (r.state === 'queued' || r.state === 'downloading' || r.state === 'paused' || r.state === 'error')
    )
    if (same) {
      if (same.state === 'paused' || same.state === 'error') this.requeue(same)
      return this.toItem(same)
    }
    const rec: DownloadRecord = {
      ...plan,
      id: newId('dl_'),
      state: 'queued',
      createdAt: Date.now(),
      files: plan.files.map((f) => ({ ...f, done: false }))
    }
    this.records.push(rec)
    this.trimHistory()
    this.persistSoon()
    this.notify()
    this.pump()
    return this.toItem(rec)
  }

  async pause(id: string): Promise<void> {
    const rec = this.find(id)
    if (rec.state === 'queued') {
      this.setState(rec, 'paused')
    } else if (rec.state === 'downloading') {
      const rt = this.runtime(rec)
      rt.controller?.abort('pause')
      await rt.running
    }
  }

  async resume(id: string): Promise<void> {
    const rec = this.find(id)
    if (rec.state === 'paused' || rec.state === 'error' || rec.state === 'canceled') this.requeue(rec)
  }

  async cancel(id: string): Promise<void> {
    const rec = this.find(id)
    if (rec.state === 'downloading') {
      const rt = this.runtime(rec)
      rt.controller?.abort('cancel')
      await rt.running
    } else if (rec.state === 'queued' || rec.state === 'paused' || rec.state === 'error') {
      await this.cleanupFiles(rec)
      rec.error = undefined
      this.setState(rec, 'canceled')
    }
  }

  /** Убирает завершённые/отменённые/ошибочные из списка (у ошибочных удаляет недокачанное). */
  async clearFinished(): Promise<void> {
    const gone = this.records.filter((r) => FINISHED.includes(r.state))
    for (const r of gone) if (r.state === 'error') await this.cleanupFiles(r)
    this.records = this.records.filter((r) => !gone.includes(r))
    for (const r of gone) this.rt.delete(r.id)
    this.persistSoon()
    this.notify()
  }

  /** Останавливает активные загрузки (они станут «на паузе») и сохраняет состояние. */
  async shutdown(): Promise<void> {
    this.closed = true
    const running: Promise<void>[] = []
    for (const r of this.records) {
      const rt = this.rt.get(r.id)
      if (r.state === 'downloading' && rt) {
        rt.controller?.abort('shutdown')
        if (rt.running) running.push(rt.running)
      } else if (r.state === 'queued') {
        r.state = 'paused'
      }
    }
    await Promise.race([Promise.allSettled(running), new Promise((res) => setTimeout(res, 10_000).unref())])
    clearInterval(this.speedTimer)
    clearTimeout(this.emitTimer)
    this.speedTimer = undefined
    this.emitTimer = undefined
    await this.persistNow()
  }

  // ---------- внутреннее ----------

  private find(id: string): DownloadRecord {
    const rec = this.records.find((r) => r.id === id)
    if (!rec) throw new HfError('Загрузка не найдена.', 'input')
    return rec
  }

  private runtime(rec: DownloadRecord): Runtime {
    let rt = this.rt.get(rec.id)
    if (!rt) {
      rt = {
        bytes: rec.files.map((f) => (f.done ? f.size : 0)),
        phase: '',
        speed: 0,
        sampleBytes: 0,
        sampleAt: Date.now()
      }
      this.rt.set(rec.id, rt)
    }
    return rt
  }

  private toItem(rec: DownloadRecord): DownloadItem {
    const rt = this.runtime(rec)
    const total = rec.files.reduce((s, f) => s + f.size, 0)
    const received = Math.min(
      total,
      rt.bytes.reduce((s, b) => s + b, 0)
    )
    return {
      id: rec.id,
      title: rec.title,
      phase: rec.state === 'downloading' && rt.phase ? rt.phase : PHASE[rec.state],
      receivedBytes: rec.state === 'done' ? total : received,
      totalBytes: total,
      done: rec.state === 'done',
      ...(rec.error ? { error: rec.error } : {}),
      repo: rec.repo,
      optionKey: rec.optionKey,
      state: rec.state,
      speedBps: rec.state === 'downloading' ? Math.round(rt.speed) : 0,
      targetPath: rec.targetPath
    }
  }

  private setState(rec: DownloadRecord, state: State): void {
    rec.state = state
    if (FINISHED.includes(state)) rec.finishedAt = Date.now()
    else delete rec.finishedAt
    const rt = this.runtime(rec)
    if (state !== 'downloading') {
      rt.phase = ''
      rt.speed = 0
    }
    this.persistSoon()
    this.notify()
  }

  private requeue(rec: DownloadRecord): void {
    rec.error = undefined
    this.setState(rec, 'queued')
    this.pump()
  }

  private trimHistory(): void {
    let extra = this.records.length - HISTORY_LIMIT
    if (extra <= 0) return
    this.records = this.records.filter((r) => {
      if (extra > 0 && FINISHED.includes(r.state) && r.state !== 'error') {
        extra--
        this.rt.delete(r.id)
        return false
      }
      return true
    })
  }

  /** Байты на диске по файлам (готовые, .part). */
  private async refreshBytes(rec: DownloadRecord): Promise<void> {
    const rt = this.runtime(rec)
    rt.bytes = await Promise.all(
      rec.files.map(async (f) => {
        if (f.done) return f.size
        if ((await statSize(f.target)) === f.size) return f.size
        return Math.min(f.size, (await statSize(partPath(f.target))) ?? 0)
      })
    )
  }

  private pump(): void {
    if (this.closed) return
    const max = Math.max(1, this.opts.maxConcurrent ?? MAX_CONCURRENT_DOWNLOADS)
    let active = this.records.filter((r) => r.state === 'downloading').length
    for (const rec of this.records) {
      if (active >= max) break
      if (rec.state !== 'queued') continue
      active++
      this.run(rec)
    }
  }

  private run(rec: DownloadRecord): void {
    const rt = this.runtime(rec)
    const ctrl = new AbortController()
    rt.controller = ctrl
    rec.error = undefined
    this.setState(rec, 'downloading')
    rt.phase = 'Подготовка'
    this.ensureTicker()

    rt.running = (async () => {
      try {
        await this.refreshBytes(rec)
        rt.sampleBytes = rt.bytes.reduce((s, b) => s + b, 0)
        rt.sampleAt = Date.now()
        await this.ensureDiskSpace(rec)
        const token = this.opts.getToken ? await this.opts.getToken() : null
        const n = rec.files.length
        for (let i = 0; i < n; i++) {
          const f = rec.files[i] as FileRecord
          if (ctrl.signal.aborted) throw ctrl.signal.reason
          if (f.done && (await statSize(f.target)) === f.size) {
            rt.bytes[i] = f.size
            continue
          }
          f.done = false
          const name = parsePath(f.target).base
          const label = n > 1 ? `Загрузка ${i + 1}/${n}: ${name}` : 'Загрузка'
          rt.phase = label
          this.notify()
          const res = await transferFile(
            { url: resolveUrl(this.baseUrl, rec.repo, rec.urlRevision, f.path), size: f.size, sha256: f.sha256, target: f.target },
            {
              ...this.opts.transfer,
              signal: ctrl.signal,
              token,
              onBytes: (b) => {
                rt.bytes[i] = b
                this.notify()
              },
              onStatus: (s) => {
                rt.phase = this.statusPhase(s, label, i, n)
                this.notify()
              }
            }
          )
          f.done = true
          if (res.skipped) f.preexisting = true
          rt.bytes[i] = f.size
          this.persistSoon()
        }
        this.setState(rec, 'done')
        await this.persistNow()
        try {
          await this.opts.onItemDone?.(this.toItem(rec))
        } catch {
          // обновление списка моделей не должно ломать загрузку
        }
      } catch (err) {
        if (ctrl.signal.aborted) {
          if (ctrl.signal.reason === 'cancel') {
            await this.cleanupFiles(rec)
            this.setState(rec, 'canceled')
          } else {
            this.setState(rec, 'paused')
          }
        } else {
          rec.error = toHfError(err).message
          this.setState(rec, 'error')
        }
      } finally {
        rt.controller = undefined
        rt.running = undefined
        rt.speed = 0
        this.ensureTicker()
        this.persistSoon()
        this.notify()
        this.pump()
      }
    })()
  }

  private statusPhase(s: TransferStatus, label: string, i: number, n: number): string {
    if (s.kind === 'download') return label
    if (s.kind === 'verify') {
      const pct = s.total > 0 ? Math.floor((s.done / s.total) * 100) : 0
      return `Проверка SHA256${n > 1 ? ` ${i + 1}/${n}` : ''}: ${pct}%`
    }
    return `Повтор через ${Math.ceil(s.delayMs / 1000)} с (попытка ${s.attempt} из ${s.maxAttempts}): ${s.message}`
  }

  private async ensureDiskSpace(rec: DownloadRecord): Promise<void> {
    const rt = this.runtime(rec)
    let remaining = 0
    rec.files.forEach((f, i) => {
      if (!f.done) remaining += Math.max(0, f.size - (rt.bytes[i] ?? 0))
    })
    if (remaining <= 0 || !rec.files[0]) return
    const dir = await existingAncestor(dirname(rec.files[0].target))
    const free = await (this.opts.diskFree ?? defaultDiskFree)(dir)
    const reserve = this.opts.diskReserveBytes ?? DISK_RESERVE_BYTES
    if (free !== null && free < remaining + reserve) {
      throw new HfError(
        `Недостаточно места на диске ${parsePath(dir).root || dir}: нужно ${formatSize(remaining + reserve)}, свободно ${formatSize(free)}.`,
        'disk'
      )
    }
  }

  /** Удаляет .part и файлы, скачанные этой загрузкой; пустые папки модели — тоже. */
  private async cleanupFiles(rec: DownloadRecord): Promise<void> {
    const rt = this.runtime(rec)
    const dirs = new Set<string>()
    for (const [i, f] of rec.files.entries()) {
      await fs.rm(partPath(f.target), { force: true }).catch(() => undefined)
      if (f.done && !f.preexisting) {
        await fs.rm(f.target, { force: true }).catch(() => undefined)
        f.done = false
      }
      rt.bytes[i] = f.done ? f.size : 0
      for (let d = dirname(f.target); d.length > rec.modelDir.length && d.startsWith(rec.modelDir); d = dirname(d)) dirs.add(d)
    }
    const ordered = [...dirs].sort((a, b) => b.length - a.length)
    for (const d of [...ordered, rec.modelDir, dirname(rec.modelDir)]) {
      await fs.rmdir(d).catch(() => undefined)
    }
  }

  private ensureTicker(): void {
    const any = this.records.some((r) => r.state === 'downloading')
    if (any && !this.speedTimer) {
      this.speedTimer = setInterval(() => this.tick(), this.opts.speedSampleMs ?? SPEED_SAMPLE_MS)
      this.speedTimer.unref?.()
    } else if (!any && this.speedTimer) {
      clearInterval(this.speedTimer)
      this.speedTimer = undefined
    }
  }

  private tick(): void {
    const now = Date.now()
    for (const rec of this.records) {
      if (rec.state !== 'downloading') continue
      const rt = this.runtime(rec)
      const total = rt.bytes.reduce((s, b) => s + b, 0)
      const dt = (now - rt.sampleAt) / 1000
      if (dt <= 0) continue
      const inst = Math.max(0, total - rt.sampleBytes) / dt
      rt.speed = rt.speed > 0 ? rt.speed * 0.7 + inst * 0.3 : inst
      rt.sampleBytes = total
      rt.sampleAt = now
    }
    this.notify()
  }

  /** Событие downloads:update не чаще emitIntervalMs. */
  private notify(): void {
    if (this.emitTimer || !this.opts.onUpdate) return
    const interval = this.opts.emitIntervalMs ?? 250
    const wait = Math.max(0, this.lastEmit + interval - Date.now())
    this.emitTimer = setTimeout(() => {
      this.emitTimer = undefined
      this.lastEmit = Date.now()
      this.opts.onUpdate?.(this.list())
    }, wait)
  }

  private persistSoon(): void {
    if (this.persistTimer) return
    this.persistTimer = setTimeout(() => {
      this.persistTimer = undefined
      void this.persistNow()
    }, 500)
    this.persistTimer.unref?.()
  }

  persistNow(): Promise<void> {
    clearTimeout(this.persistTimer)
    this.persistTimer = undefined
    const snapshot = JSON.parse(JSON.stringify({ version: 1, items: this.records })) as unknown
    this.persistChain = this.persistChain
      .then(() => writeJson(this.opts.stateFile, snapshot))
      .catch(() => undefined)
    return this.persistChain
  }
}
