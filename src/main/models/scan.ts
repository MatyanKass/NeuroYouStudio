// Сканирование папки моделей (без electron — тестируется отдельно).
// Раскладка как в LM Studio: <modelsDir>/<publisher>/<repo>/<file>.gguf,
// EXL3: <modelsDir>/<publisher>/<repo>__<revision>/ (папка = модель).

import { promises as fs } from 'node:fs'
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { ModelArchInfo, ModelTensorStats, LocalModel } from '@shared/types'
import { ggufShardInfo, ggufShardPaths, readGgufModel } from './gguf'
import { describeGguf } from './gguf-info'
import { isExl3Dir, readExl3Model } from './exl3'

export const MODEL_CACHE_VERSION = 1
const MAX_DEPTH = 4

/** Разобранные метаданные одной модели или mmproj (кэшируются). */
export interface CachedModelInfo {
  format: 'gguf' | 'exl3'
  isMmproj?: boolean
  mmprojHasVision?: boolean
  arch?: ModelArchInfo
  tensors?: ModelTensorStats
  isMoe: boolean
  isEmbedding: boolean
  vision?: boolean
  quant: string
  paramsLabel: string
  chatTemplate?: string
  bpw?: number
  error?: string
}

export interface ModelCache {
  version: number
  /** Ключ — абсолютный путь (первый шард / папка EXL3). */
  entries: Record<string, { fp: string; info: CachedModelInfo }>
}

export const emptyModelCache = (): ModelCache => ({ version: MODEL_CACHE_VERSION, entries: {} })

export interface ScanResult {
  models: LocalModel[]
  cache: ModelCache
  /** Кэш изменился — стоит сохранить. */
  cacheChanged: boolean
}

interface Found {
  ggufs: string[]
  exl3Dirs: string[]
  /** Недокачанные файлы (*.part) — такие модели пока не показываем. */
  parts: Set<string>
}

async function walk(dir: string, depth: number, out: Found): Promise<void> {
  let entries: import('node:fs').Dirent[]
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  if (depth > 0 && entries.some((e) => e.isFile() && e.name === 'config.json')) {
    if (entries.some((e) => e.isFile() && e.name.endsWith('.safetensors')) && (await isExl3Dir(dir))) {
      // папка ещё качается — пропускаем
      if (!entries.some((e) => e.isFile() && e.name.endsWith('.part'))) out.exl3Dirs.push(dir)
      return
    }
  }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue
    const p = join(dir, e.name)
    if (e.isDirectory()) {
      if (depth < MAX_DEPTH) await walk(p, depth + 1, out)
    } else if (e.isFile() && /\.gguf$/i.test(e.name)) {
      out.ggufs.push(p)
    } else if (e.isFile() && /\.gguf\.part$/i.test(e.name)) {
      out.parts.add(p.slice(0, -'.part'.length).toLowerCase())
    }
  }
}

/** Отпечаток набора файлов: размер + mtime. */
async function fingerprint(paths: string[]): Promise<{ fp: string; size: number; missing: number }> {
  const parts: string[] = []
  let size = 0
  let missing = 0
  for (const p of paths) {
    const st = await fs.stat(p).catch(() => undefined)
    if (!st) {
      missing++
      parts.push('-')
      continue
    }
    size += st.size
    parts.push(`${st.size}:${Math.round(st.mtimeMs)}`)
  }
  return { fp: parts.join('|'), size, missing }
}

const toId = (root: string, p: string): string => relative(root, p).split(sep).join('/')

/** publisher/repo из относительного пути папки. */
function ownerRepo(relDir: string, exl3: boolean): { publisher: string; repo: string } {
  const parts = relDir.split('/').filter((x) => x && x !== '.')
  const strip = (s: string): string => (exl3 ? s.replace(/__[^_].*$/, '') : s)
  if (parts.length >= 2) return { publisher: parts[0]!, repo: strip(parts[1]!) }
  if (parts.length === 1) return { publisher: '', repo: strip(parts[0]!) }
  return { publisher: '', repo: '' }
}

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e))

async function parseGgufCached(
  path: string,
  shardPaths: string[],
  cache: ModelCache,
  next: ModelCache
): Promise<{ info: CachedModelInfo; size: number; changed: boolean }> {
  const { fp, size, missing } = await fingerprint(shardPaths)
  const hit = cache.entries[path]
  if (hit && hit.fp === fp) {
    next.entries[path] = hit
    return { info: hit.info, size, changed: false }
  }
  let info: CachedModelInfo
  if (missing > 0) {
    info = {
      format: 'gguf',
      isMoe: false,
      isEmbedding: false,
      quant: '',
      paramsLabel: '',
      error: `Не хватает шардов: найдено ${shardPaths.length - missing} из ${shardPaths.length}`
    }
  } else {
    try {
      const g = await readGgufModel(path)
      const d = describeGguf(g, basename(path))
      info = {
        format: 'gguf',
        isMmproj: d.isMmproj || undefined,
        mmprojHasVision: d.isMmproj ? d.mmprojHasVision : undefined,
        arch: d.arch,
        tensors: d.isMmproj ? undefined : d.tensors,
        isMoe: d.isMoe,
        isEmbedding: d.isEmbedding,
        quant: d.quant,
        paramsLabel: d.paramsLabel,
        chatTemplate: d.chatTemplate
      }
    } catch (e) {
      info = {
        format: 'gguf',
        isMmproj: /mmproj/i.test(basename(path)) || undefined,
        isMoe: false,
        isEmbedding: false,
        quant: '',
        paramsLabel: '',
        error: `Не удалось прочитать GGUF: ${errMsg(e)}`
      }
    }
  }
  next.entries[path] = { fp, info }
  return { info, size, changed: true }
}

/** Отпечаток папки EXL3: все файлы верхнего уровня. */
async function exl3Files(dir: string): Promise<string[]> {
  const names = await fs.readdir(dir).catch(() => [] as string[])
  return names.sort().map((n) => join(dir, n))
}

/** Предпочтение точности mmproj: F16 → BF16 → Q8 → прочее → F32. */
function mmprojPrecisionRank(name: string): number {
  const n = name.toLowerCase()
  if (/bf16/.test(n)) return 1
  if (/f16|fp16/.test(n)) return 0
  if (/q8/.test(n)) return 2
  if (/f32|fp32/.test(n)) return 4
  return 3
}

/** Имя без служебных частей — для сравнения модели и mmproj. */
function normName(name: string): string {
  return name
    .toLowerCase()
    .replace(/\.gguf$/, '')
    .replace(/mmproj/g, '')
    .replace(/(?:^|[-._])(?:ud-)?(?:i?q\d(?:_[a-z0-9]{1,4}){0,3}|bf16|f16|f32|fp16|fp32)(?=$|[-._])/g, '')
    .replace(/[-._\s]+/g, '')
}

function commonPrefix(a: string, b: string): number {
  let i = 0
  while (i < a.length && i < b.length && a[i] === b[i]) i++
  return i
}

/** Лучший mmproj для модели среди файлов той же папки. */
export function pickMmproj(modelFile: string, mmprojs: string[]): string | undefined {
  if (mmprojs.length === 0) return undefined
  const m = normName(basename(modelFile))
  const scored = mmprojs.map((p) => {
    const sim = commonPrefix(m, normName(basename(p)))
    return { p, sim: sim >= 4 ? sim : 0, rank: mmprojPrecisionRank(basename(p)) }
  })
  scored.sort((a, b) => b.sim - a.sim || a.rank - b.rank || a.p.localeCompare(b.p))
  return scored[0]!.p
}

/** Полное сканирование. cache — предыдущий кэш (берутся только совпавшие отпечатки). */
export async function scanModelsDir(root: string, cache: ModelCache = emptyModelCache()): Promise<ScanResult> {
  const prev = cache.version === MODEL_CACHE_VERSION ? cache : emptyModelCache()
  const next = emptyModelCache()
  let changed = prev !== cache
  const found: Found = { ggufs: [], exl3Dirs: [], parts: new Set() }
  await walk(root, 0, found)

  // Группируем шарды: модель = первый шард (или одиночный файл).
  const groups = new Map<string, string[]>()
  for (const p of found.ggufs) {
    const sh = ggufShardInfo(p)
    const first = sh ? ggufShardPaths(p)[0]! : p
    const key = first.toLowerCase()
    const g = groups.get(key)
    if (g) g.push(p)
    else groups.set(key, [p])
  }

  interface Pending {
    first: string
    shards: string[]
    info: CachedModelInfo
    size: number
  }
  const ggufModels: Pending[] = []
  const mmprojByDir = new Map<string, string[]>()
  const mmprojSize = new Map<string, number>()

  const tasks = [...groups.values()].map((files) => async () => {
    const sh = ggufShardInfo(files[0]!)
    const shards = sh ? ggufShardPaths(files[0]!) : [files[0]!]
    const first = shards[0]!
    // шардированная модель ещё докачивается
    if (shards.some((p) => found.parts.has(p.toLowerCase()))) return
    const r = await parseGgufCached(first, shards, prev, next)
    changed ||= r.changed
    const isMmproj = r.info.isMmproj ?? false
    if (isMmproj) {
      if (r.info.mmprojHasVision !== false && !r.info.error) {
        const d = dirname(first)
        mmprojByDir.set(d, [...(mmprojByDir.get(d) ?? []), first])
        mmprojSize.set(first, r.size)
      }
      return
    }
    ggufModels.push({ first, shards, info: r.info, size: r.size })
  })
  await runLimited(tasks, 4)

  const models: LocalModel[] = []
  for (const m of ggufModels) {
    const rel = toId(root, m.first)
    const { publisher, repo } = ownerRepo(toId(root, dirname(m.first)), false)
    const sh = ggufShardInfo(m.first)
    const name = sh ? sh.base : basename(m.first).replace(/\.gguf$/i, '')
    const mmprojPath = m.info.isEmbedding ? undefined : pickMmproj(m.first, mmprojByDir.get(dirname(m.first)) ?? [])
    models.push({
      id: rel,
      format: 'gguf',
      path: m.first,
      files: m.shards,
      sizeBytes: m.size,
      publisher,
      repo,
      name,
      quant: m.info.quant,
      paramsLabel: m.info.paramsLabel,
      arch: m.info.arch,
      tensors: m.info.tensors,
      isMoe: m.info.isMoe,
      vision: mmprojPath !== undefined,
      mmprojPath,
      mmprojSizeBytes: mmprojPath ? mmprojSize.get(mmprojPath) : undefined,
      isEmbedding: m.info.isEmbedding,
      chatTemplate: m.info.chatTemplate,
      error: m.info.error
    })
  }

  for (const dir of found.exl3Dirs) {
    const files = await exl3Files(dir)
    const { fp, size } = await fingerprint(files)
    const { publisher, repo } = ownerRepo(toId(root, dir), true)
    let info: CachedModelInfo
    const hit = prev.entries[dir]
    if (hit && hit.fp === fp) {
      info = hit.info
    } else {
      changed = true
      try {
        const x = await readExl3Model(dir, repo || basename(dir))
        info = {
          format: 'exl3',
          arch: x.arch,
          tensors: x.tensors,
          isMoe: x.isMoe,
          isEmbedding: false,
          vision: x.vision,
          quant: x.quant,
          paramsLabel: x.paramsLabel,
          chatTemplate: x.chatTemplate,
          bpw: x.bpw
        }
      } catch (e) {
        info = {
          format: 'exl3',
          isMoe: false,
          isEmbedding: false,
          quant: 'EXL3',
          paramsLabel: '',
          error: `Не удалось прочитать EXL3: ${errMsg(e)}`
        }
      }
    }
    next.entries[dir] = { fp, info }
    models.push({
      id: toId(root, dir),
      format: 'exl3',
      path: dir,
      files,
      sizeBytes: size,
      publisher,
      repo,
      name: repo || basename(dir),
      quant: info.quant,
      paramsLabel: info.paramsLabel,
      arch: info.arch,
      tensors: info.tensors,
      isMoe: info.isMoe,
      vision: info.vision ?? false,
      isEmbedding: false,
      chatTemplate: info.chatTemplate,
      bpw: info.bpw,
      error: info.error
    })
  }

  if (Object.keys(prev.entries).length !== Object.keys(next.entries).length) changed = true
  models.sort(
    (a, b) =>
      a.publisher.localeCompare(b.publisher) || a.repo.localeCompare(b.repo) || a.name.localeCompare(b.name)
  )
  return { models, cache: next, cacheChanged: changed }
}

async function runLimited(tasks: Array<() => Promise<void>>, limit: number): Promise<void> {
  let i = 0
  const worker = async (): Promise<void> => {
    while (i < tasks.length) {
      const t = tasks[i++]!
      await t()
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker))
}

// ---------- Удаление ----------

/** Файлы, из-за которых папку не жалко удалить, если моделей в ней не осталось. */
const DISPOSABLE_EXT = new Set(['.json', '.md', '.txt', '.gitattributes', '.jinja'])

function isInside(root: string, p: string): boolean {
  const r = relative(resolve(root), resolve(p))
  return r !== '' && !r.startsWith('..') && !isAbsolute(r)
}

/** Удаляет папку, если в ней не осталось ничего ценного; затем поднимается выше (до root). */
async function pruneDirs(root: string, dir: string): Promise<void> {
  let cur = dir
  while (isInside(root, cur)) {
    const entries = await fs.readdir(cur, { withFileTypes: true }).catch(() => undefined)
    if (!entries) return
    const disposable = entries.every(
      (e) => e.isFile() && (DISPOSABLE_EXT.has(extname(e.name).toLowerCase()) || e.name === '.gitattributes')
    )
    if (!disposable) return
    await fs.rm(cur, { recursive: true, force: true })
    cur = dirname(cur)
  }
}

/** Удаляет файлы модели (все шарды / папку EXL3) и опустевшие папки репозитория. */
export async function deleteModelFiles(root: string, model: LocalModel): Promise<void> {
  if (!isInside(root, model.path)) throw new Error('Модель вне папки моделей — удаление запрещено')
  if (model.format === 'exl3') {
    await fs.rm(model.path, { recursive: true, force: true })
    await pruneDirs(root, dirname(model.path))
    return
  }
  for (const f of model.files.length ? model.files : [model.path]) {
    if (isInside(root, f)) await fs.rm(f, { force: true })
  }
  const dir = dirname(model.path)
  // Других моделей в папке не осталось — mmproj больше не нужен.
  const rest = await fs.readdir(dir, { withFileTypes: true }).catch(() => [])
  const ggufs = rest.filter((e) => e.isFile() && /\.gguf$/i.test(e.name))
  if (ggufs.length > 0 && ggufs.every((e) => /mmproj/i.test(e.name))) {
    for (const e of ggufs) await fs.rm(join(dir, e.name), { force: true })
  }
  await pruneDirs(root, dir)
}
