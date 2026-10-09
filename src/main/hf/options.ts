// Разбор файлов репозитория HF в варианты загрузки (без Electron и сети).
import { join } from 'node:path'
import type { ModelFormat } from '@shared/config'
import type { HfFileOption } from '@shared/types'

export interface HfTreeEntry {
  type: 'file' | 'directory' | string
  path: string
  size?: number
  oid?: string
  lfs?: { oid?: string; size?: number }
}

export interface RepoFile {
  path: string
  size: number
  /** SHA256 из lfs.oid, если файл в LFS. */
  sha256?: string
}

/** Вариант с данными, нужными загрузчику (sha256 файлов, коммит). В IPC уходит как HfFileOption. */
export interface RichOption extends HfFileOption {
  files: RepoFile[]
  /** Коммит, с которого качать (стабильные URL для докачки). */
  commit?: string
}

export interface Exl3QuantConfig {
  quant_method?: string
  bits?: number
  head_bits?: number
}

export interface Exl3Branch {
  name: string
  commit?: string
  files: RepoFile[]
  quantConfig?: Exl3QuantConfig
}

const SHARD_RE = /^(.*)-(\d{5})-of-(\d{5})\.gguf$/i
const QUANT_RE =
  /(?:^|[-_.\s])((?:UD-)?(?:I?Q\d(?:_[A-Z0-9]+)*|TQ\d_\d|MXFP4(?:_MOE)?|NVFP4|BF16|FP16|FP32|FP8|F16|F32))(?=$|[-_.\s])/gi
const SHA256_RE = /^[0-9a-f]{64}$/i

export function treeFiles(tree: HfTreeEntry[]): RepoFile[] {
  const out: RepoFile[] = []
  for (const e of tree) {
    if (e.type !== 'file' || typeof e.path !== 'string') continue
    const size = Number(e.lfs?.size ?? e.size ?? 0)
    const oid = e.lfs?.oid
    out.push({ path: e.path, size: Number.isFinite(size) ? size : 0, ...(oid && SHA256_RE.test(oid) ? { sha256: oid.toLowerCase() } : {}) })
  }
  return out
}

const baseName = (p: string): string => p.slice(p.lastIndexOf('/') + 1)
const dirName = (p: string): string => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '')

/** Метка кванта из имени файла: Q4_K_M, IQ4_XS, UD-Q4_K_XL, Q8_0, BF16, MXFP4… ('' если не найдено). */
export function parseQuant(name: string): string {
  const stem = baseName(name)
    .replace(/\.gguf$/i, '')
    .replace(/-\d{5}-of-\d{5}$/i, '')
  let last = ''
  for (const m of stem.matchAll(QUANT_RE)) last = m[1] ?? last
  return last.toUpperCase()
}

export function pluralParts(n: number): string {
  const m10 = n % 10
  const m100 = n % 100
  if (m10 === 1 && m100 !== 11) return 'часть'
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return 'части'
  return 'частей'
}

interface GgufGroup {
  stem: string
  dir: string
  files: RepoFile[]
}

/** Группирует .gguf: один файл или набор шардов = один вариант; mmproj — отдельным списком. */
export function groupGgufOptions(
  files: RepoFile[],
  revision = 'main',
  commit?: string
): { options: RichOption[]; mmproj: RichOption[] } {
  const groups = new Map<string, GgufGroup>()
  for (const f of files) {
    if (!/\.gguf$/i.test(f.path)) continue
    const name = baseName(f.path)
    const dir = dirName(f.path)
    const m = SHARD_RE.exec(name)
    const stem = m ? (m[1] ?? name) : name.replace(/\.gguf$/i, '')
    const key = m ? `${dir}/${stem}#${m[3]}` : f.path
    const g = groups.get(key) ?? { stem, dir, files: [] }
    g.files.push(f)
    groups.set(key, g)
  }

  const options: RichOption[] = []
  const mmproj: RichOption[] = []
  for (const g of groups.values()) {
    g.files.sort((a, b) => a.path.localeCompare(b.path))
    const first = g.files[0]
    if (!first) continue
    const quant = parseQuant(g.stem) || parseQuant(g.dir.replace(/\//g, '-'))
    // imatrix_*.gguf — данные калибровки, не модель.
    if (/imatrix/i.test(g.stem) && !quant) continue
    const isMmproj = /mmproj/i.test(g.stem)
    const n = g.files.length
    const opt: RichOption = {
      key: first.path,
      label: n > 1 ? `${g.stem} (${n} ${pluralParts(n)})` : g.stem,
      quant,
      revision,
      files: g.files.map((f) => ({ ...f })),
      sizeBytes: g.files.reduce((s, f) => s + f.size, 0),
      downloaded: false,
      isMmproj,
      ...(commit ? { commit } : {})
    }
    ;(isMmproj ? mmproj : options).push(opt)
  }
  const bySize = (a: RichOption, b: RichOption): number => a.sizeBytes - b.sizeBytes || a.key.localeCompare(b.key)
  options.sort(bySize)
  mmproj.sort(bySize)
  return { options, mmproj }
}

function fmtBits(n: number): string {
  return Number.isInteger(n) ? n.toFixed(1) : String(n)
}

/** Метка кванта EXL3: имя ветки вида 4.0bpw_H6, иначе из quantization_config или имени репозитория. */
export function exl3QuantLabel(branch: string, qc?: Exl3QuantConfig, repoName = ''): string {
  if (branch !== 'main' && /bpw/i.test(branch)) return branch
  if (qc && typeof qc.bits === 'number') {
    return `${fmtBits(qc.bits)}bpw${typeof qc.head_bits === 'number' ? `_H${qc.head_bits}` : ''}`
  }
  const m = /(\d+(?:\.\d+)?)\s*bpw(?:[_-]?h(\d+))?/i.exec(repoName)
  if (m) return `${m[1]}bpw${m[2] ? `_H${m[2]}` : ''}`
  return branch
}

/** Вариант EXL3 для ветки (null, если в ветке нет .safetensors). */
export function buildExl3Option(branch: Exl3Branch, repoName = ''): RichOption | null {
  const files = branch.files.filter((f) => f.path !== '.gitattributes')
  if (!files.some((f) => /\.safetensors$/i.test(f.path))) return null
  const quant = exl3QuantLabel(branch.name, branch.quantConfig, repoName)
  return {
    key: branch.name,
    label: branch.name === 'main' ? `main (${quant})` : branch.name,
    quant,
    revision: branch.name,
    files: files.map((f) => ({ ...f })),
    sizeBytes: files.reduce((s, f) => s + f.size, 0),
    downloaded: false,
    isMmproj: false,
    ...(branch.commit ? { commit: branch.commit } : {})
  }
}

export function buildExl3Options(branches: Exl3Branch[], repoName = ''): RichOption[] {
  return branches
    .map((b) => buildExl3Option(b, repoName))
    .filter((o): o is RichOption => o !== null)
    .sort((a, b) => a.sizeBytes - b.sizeBytes || a.key.localeCompare(b.key))
}

/** Убирает YAML front matter и обрезает README. */
export function readmeExcerpt(md: string, max = 1500): string {
  let s = md.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n')
  const fm = /^---\n[\s\S]*?\n---[ \t]*(?:\n|$)/.exec(s)
  if (fm) s = s.slice(fm[0].length)
  s = s.trim()
  if (s.length <= max) return s
  const cut = s.slice(0, max)
  const nl = cut.lastIndexOf('\n')
  return `${nl > max * 0.6 ? cut.slice(0, nl) : cut}…`
}

const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)$/i

/** Имя папки/файла, безопасное для Windows. */
export function sanitizeSegment(s: string): string {
  // eslint-disable-next-line no-control-regex
  let out = s.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/g, '')
  if (out === '' || out === '.' || out === '..') out = '_'
  if (RESERVED.test(out.split('.')[0] ?? '')) out = `_${out}`
  return out
}

export function splitRepoId(repoId: string): { author: string; name: string } {
  const i = repoId.indexOf('/')
  return i < 0 ? { author: '_', name: repoId } : { author: repoId.slice(0, i), name: repoId.slice(i + 1) }
}

/** Папка модели: GGUF — <author>/<repo>, EXL3 — <author>/<repo>__<ветка>. */
export function modelDir(modelsDir: string, repoId: string, format: ModelFormat, revision = 'main'): string {
  const { author, name } = splitRepoId(repoId)
  const folder = format === 'exl3' ? `${sanitizeSegment(name)}__${sanitizeSegment(revision)}` : sanitizeSegment(name)
  return join(modelsDir, sanitizeSegment(author), folder)
}

/** Куда положить файл репозитория. GGUF — только имя файла, EXL3 — с подпапками. */
export function fileTarget(
  modelsDir: string,
  repoId: string,
  format: ModelFormat,
  revision: string,
  filePath: string
): string {
  const dir = modelDir(modelsDir, repoId, format, revision)
  if (format === 'gguf') return join(dir, sanitizeSegment(baseName(filePath)))
  return join(dir, ...filePath.split('/').filter(Boolean).map(sanitizeSegment))
}

/** Путь модели для DownloadItem.targetPath: первый файл GGUF или папка EXL3. */
export function optionTargetPath(modelsDir: string, repoId: string, format: ModelFormat, option: HfFileOption): string {
  if (format === 'exl3') return modelDir(modelsDir, repoId, format, option.revision)
  const first = option.files[0]
  return first ? fileTarget(modelsDir, repoId, format, option.revision, first.path) : modelDir(modelsDir, repoId, format)
}
