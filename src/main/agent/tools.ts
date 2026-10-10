// Инструменты агента: JSON-схемы (формат OpenAI function calling) и исполнители.
// Имена и параметры — по-английски (так надёжнее для моделей), описания — по-русски.
import { spawn } from 'node:child_process'
import { execFile } from 'node:child_process'
import { statSync, promises as fs } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import type { AgentShell } from '@shared/config'
import type { ToolName } from '@shared/types'
import { unifiedDiff } from './diff'

export interface ToolContext {
  /** Рабочая папка: относительные пути и команды по умолчанию выполняются относительно неё. */
  cwd: string
  defaultShell: AgentShell
  commandTimeoutSec: number
  maxOutputChars: number
  /** Отмена (кнопка «Стоп»): прерывает команду и убивает дерево процессов. */
  signal: AbortSignal
}

export interface ToolResult {
  /** Текст, который уйдёт модели (уже усечён). */
  content: string
  /** Инструмент считает действие ошибкой (модель должна это увидеть). */
  isError?: boolean
  /** Для write_file/edit_file: unified diff для показа в интерфейсе. */
  diff?: string
  exitCode?: number
}

export interface OpenAiTool {
  type: 'function'
  function: { name: string; description: string; parameters: Record<string, unknown> }
}

const READ_ONLY: ReadonlySet<ToolName> = new Set(['read_file', 'list_dir', 'search_files'])
export const isReadOnlyTool = (name: string): boolean => READ_ONLY.has(name as ToolName)

const MAX_READ_LINES = 2000
const MAX_LIST_ENTRIES = 2000
const MAX_SEARCH_RESULTS = 200
const MAX_COMMAND_SEC = 600
const SKIP_DIRS = new Set(['node_modules', '.git', '.svn', '.hg', 'dist', 'out', '.venv', '__pycache__'])

// ---------- вспомогательное ----------

/** Относительный путь — относительно cwd; абсолютный — как есть. Нормализует разделители Windows. */
export function resolvePath(cwd: string, p: string): string {
  if (typeof p !== 'string' || !p.trim()) throw new Error('Не указан путь')
  // Модели нередко оборачивают путь в кавычки — снимаем их.
  let raw = p.trim()
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) raw = raw.slice(1, -1)
  raw = raw.trim().replace(/\//g, '\\')
  return isAbsolute(raw) ? resolve(raw) : resolve(cwd, raw)
}

/** Путь внутри рабочей папки? (для политики: запись/удаление вне cwd спрашиваем). */
export function isInside(cwd: string, target: string): boolean {
  const rel = relative(resolve(cwd), resolve(target))
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

function looksBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8000)
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true
  return false
}

/** Усечение «голова + хвост» до лимита символов. */
export function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  const head = Math.floor(maxChars * 0.6)
  const tail = maxChars - head
  const omitted = text.length - head - tail
  return `${text.slice(0, head)}\n… [пропущено символов: ${omitted}] …\n${text.slice(text.length - tail)}`
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const int = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? Math.floor(v) : undefined)

// ---------- исполнители ----------

async function readFileTool(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const path = resolvePath(ctx.cwd, str(args.path))
  const buf = await fs.readFile(path)
  if (looksBinary(buf)) return { content: `[Двоичный файл, ${buf.length} байт — не показан]` }
  const all = buf.toString('utf8').split('\n')
  const offset = Math.max(0, (int(args.offset) ?? 1) - 1)
  const limit = Math.min(int(args.limit) ?? MAX_READ_LINES, MAX_READ_LINES)
  const slice = all.slice(offset, offset + limit)
  const width = String(offset + slice.length).length
  const body = slice.map((l, i) => `${String(offset + i + 1).padStart(width)}\t${l}`).join('\n')
  const more = all.length > offset + slice.length ? `\n… [ещё строк: ${all.length - offset - slice.length}]` : ''
  return { content: truncate(body + more, ctx.maxOutputChars) }
}

async function listDirTool(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const root = resolvePath(ctx.cwd, str(args.path) || '.')
  const depth = Math.max(1, Math.min(int(args.depth) ?? 1, 5))
  const out: string[] = []
  let truncated = false
  const walk = async (dir: string, level: number, prefix: string): Promise<void> => {
    if (truncated) return
    let entries: import('node:fs').Dirent[]
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch (e) {
      out.push(`${prefix}[не прочитать: ${(e as Error).message}]`)
      return
    }
    entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
    for (const e of entries) {
      if (out.length >= MAX_LIST_ENTRIES) {
        truncated = true
        return
      }
      if (e.isDirectory()) {
        out.push(`${prefix}${e.name}/`)
        if (level < depth && !SKIP_DIRS.has(e.name)) await walk(join(dir, e.name), level + 1, `${prefix}  `)
      } else {
        let size = 0
        try {
          size = (await fs.stat(join(dir, e.name))).size
        } catch {
          // недоступен — размер 0
        }
        out.push(`${prefix}${e.name} (${size} б)`)
      }
    }
  }
  await walk(root, 1, '')
  if (truncated) out.push(`… [список усечён до ${MAX_LIST_ENTRIES} записей]`)
  return { content: truncate(out.join('\n') || '(пусто)', ctx.maxOutputChars) }
}

async function searchFilesTool(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const root = resolvePath(ctx.cwd, str(args.path) || '.')
  const pattern = str(args.pattern)
  if (!pattern) throw new Error('Не задан шаблон поиска (pattern)')
  let re: RegExp
  try {
    re = new RegExp(pattern, 'i')
  } catch (e) {
    throw new Error(`Некорректное регулярное выражение: ${(e as Error).message}`, { cause: e })
  }
  const globStr = str(args.glob).trim()
  const globRe = globStr ? globToRegExp(globStr) : null
  const results: string[] = []
  let scanned = 0
  const walk = async (dir: string): Promise<void> => {
    if (results.length >= MAX_SEARCH_RESULTS || ctx.signal.aborted) return
    let entries: import('node:fs').Dirent[]
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (results.length >= MAX_SEARCH_RESULTS || ctx.signal.aborted) return
      const full = join(dir, e.name)
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) await walk(full)
        continue
      }
      if (globRe && !globRe.test(e.name)) continue
      if (scanned++ > 20000) return
      let buf: Buffer
      try {
        buf = await fs.readFile(full)
      } catch {
        continue
      }
      if (looksBinary(buf)) continue
      const lines = buf.toString('utf8').split('\n')
      for (let i = 0; i < lines.length; i++) {
        if (re.test(lines[i]!)) {
          results.push(`${relative(ctx.cwd, full) || full}:${i + 1}: ${lines[i]!.trim().slice(0, 300)}`)
          if (results.length >= MAX_SEARCH_RESULTS) break
        }
      }
    }
  }
  await walk(root)
  const header = results.length >= MAX_SEARCH_RESULTS ? `[показаны первые ${MAX_SEARCH_RESULTS} совпадений]\n` : ''
  return { content: truncate(header + (results.join('\n') || '(совпадений нет)'), ctx.maxOutputChars) }
}

function globToRegExp(glob: string): RegExp {
  const esc = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')
  return new RegExp(`^${esc}$`, 'i')
}

async function readIfExists(path: string): Promise<string | null> {
  try {
    const buf = await fs.readFile(path)
    return looksBinary(buf) ? null : buf.toString('utf8')
  } catch {
    return null
  }
}

async function writeFileTool(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const path = resolvePath(ctx.cwd, str(args.path))
  const content = str(args.content)
  const old = (await readIfExists(path)) ?? ''
  await fs.mkdir(resolve(path, '..'), { recursive: true })
  await fs.writeFile(path, content, 'utf8')
  const diff = unifiedDiff(old, content, relative(ctx.cwd, path) || path)
  const verb = old ? 'перезаписан' : 'создан'
  return { content: `Файл ${verb}: ${path} (${content.length} символов)`, diff: diff || undefined }
}

async function editFileTool(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const path = resolvePath(ctx.cwd, str(args.path))
  const oldString = str(args.old_string)
  const newString = str(args.new_string)
  const replaceAll = args.replace_all === true
  if (!oldString) throw new Error('Пустой old_string: для создания файла используйте write_file')
  const buf = await fs.readFile(path)
  if (looksBinary(buf)) throw new Error('Нельзя редактировать двоичный файл')
  const text = buf.toString('utf8')
  const count = text.split(oldString).length - 1
  if (count === 0) throw new Error('old_string не найден в файле — скопируйте фрагмент точно, вместе с отступами')
  if (count > 1 && !replaceAll) {
    throw new Error(`old_string встречается ${count} раз — добавьте контекста для уникальности или укажите replace_all`)
  }
  const next = replaceAll ? text.split(oldString).join(newString) : text.replace(oldString, newString)
  await fs.writeFile(path, next, 'utf8')
  const diff = unifiedDiff(text, next, relative(ctx.cwd, path) || path)
  return { content: `Файл изменён: ${path} (замен: ${replaceAll ? count : 1})`, diff: diff || undefined }
}

// ---------- терминал ----------

export interface CommandSpec {
  exe: string
  args: string[]
}

/**
 * Абсолютные пути к оболочкам: в упакованном (MSIX) окружении System32 может не быть в PATH
 * у порождённых процессов, поэтому не полагаемся на поиск по имени.
 */
function shellExe(shell: AgentShell): string {
  const sysRoot = process.env.SystemRoot || process.env.windir || 'C:\\Windows'
  if (shell === 'cmd') return process.env.ComSpec || join(sysRoot, 'System32', 'cmd.exe')
  return join(sysRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
}

/** Как запускать команду в выбранной оболочке (UTF-8, без профиля/логотипа, без интерактива). */
export function shellSpec(shell: AgentShell, command: string): CommandSpec {
  if (shell === 'cmd') {
    return { exe: shellExe('cmd'), args: ['/d', '/s', '/c', `chcp 65001>nul & ${command}`] }
  }
  const prefixed = `[Console]::OutputEncoding=[Text.Encoding]::UTF8;${command}`
  return {
    exe: shellExe('powershell'),
    args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', prefixed]
  }
}

function killTree(pid: number): void {
  if (process.platform === 'win32') {
    execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => undefined)
  }
}

export async function runCommandTool(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const command = str(args.command)
  if (!command.trim()) throw new Error('Пустая команда')
  const shell: AgentShell = args.shell === 'cmd' || args.shell === 'powershell' ? args.shell : ctx.defaultShell
  // Несуществующая рабочая папка (например, выдуманная моделью) не должна ронять оболочку с загадочным ENOENT.
  // То же для пути к файлу вместо папки. О подмене сообщаем модели в выводе.
  const asked = args.cwd ? resolvePath(ctx.cwd, str(args.cwd)) : ctx.cwd
  const isDir = (p: string): boolean => {
    try {
      return statSync(p).isDirectory()
    } catch {
      return false
    }
  }
  const cwd = isDir(asked) ? asked : ctx.cwd
  const cwdNote = cwd !== asked ? `Папка ${asked} не существует или это файл — команда выполнена в ${cwd}.\n` : ''
  const timeoutSec = Math.min(int(args.timeout_sec) ?? ctx.commandTimeoutSec, MAX_COMMAND_SEC)
  const spec = shellSpec(shell, command)

  return await new Promise<ToolResult>((resolveResult) => {
    const child = spawn(spec.exe, spec.args, {
      cwd,
      windowsHide: true,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    const chunks: string[] = []
    let total = 0
    let timedOut = false
    let settled = false
    const cap = ctx.maxOutputChars * 4
    const collect = (d: Buffer): void => {
      if (total < cap) {
        chunks.push(d.toString('utf8'))
        total += d.length
      }
    }
    child.stdout?.on('data', collect)
    child.stderr?.on('data', collect)

    const onAbort = (): void => {
      if (child.pid) killTree(child.pid)
    }
    ctx.signal.addEventListener('abort', onAbort, { once: true })
    const timer = setTimeout(() => {
      timedOut = true
      if (child.pid) killTree(child.pid)
    }, timeoutSec * 1000)

    const finish = (exitCode: number | null, label?: string): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      ctx.signal.removeEventListener('abort', onAbort)
      const output = truncate(chunks.join('').replace(/\r\n/g, '\n').trimEnd(), ctx.maxOutputChars)
      const note = `${cwdNote}${label ? `${label}\n` : ''}`
      const code = exitCode ?? -1
      const head = ctx.signal.aborted
        ? 'Команда прервана пользователем.'
        : timedOut
          ? `Команда прервана по тайм-ауту (${timeoutSec} с).`
          : `Код возврата: ${code}.`
      resolveResult({
        content: truncate(`${note}${head}\n--- вывод ---\n${output || '(пусто)'}`, ctx.maxOutputChars),
        isError: ctx.signal.aborted || timedOut || code !== 0,
        exitCode: code
      })
    }

    child.on('error', (e) => finish(null, `Не удалось запустить оболочку: ${e.message}`))
    child.on('close', (code) => finish(code))
  })
}

// ---------- реестр ----------

type Executor = (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult>

const EXECUTORS: Record<ToolName, Executor> = {
  read_file: readFileTool,
  list_dir: listDirTool,
  search_files: searchFilesTool,
  write_file: writeFileTool,
  edit_file: editFileTool,
  run_command: runCommandTool
}

export async function executeTool(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const fn = EXECUTORS[name as ToolName]
  if (!fn) return { content: `Неизвестный инструмент: ${name}`, isError: true }
  try {
    return await fn(args, ctx)
  } catch (e) {
    return { content: `Ошибка: ${e instanceof Error ? e.message : String(e)}`, isError: true }
  }
}

export const AGENT_TOOLS: OpenAiTool[] = [
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Прочитать текстовый файл (с номерами строк). offset/limit — окно строк (с 1).',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Путь к файлу (абсолютный или относительно рабочей папки).' },
          offset: { type: 'integer', description: 'С какой строки начать (с 1).' },
          limit: { type: 'integer', description: 'Сколько строк прочитать.' }
        },
        required: ['path']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'list_dir',
      description: 'Список содержимого папки (файлы с размером, вложенные папки). depth — глубина (1–5).',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Путь к папке.' },
          depth: { type: 'integer', description: 'Глубина обхода, 1–5 (по умолчанию 1).' }
        },
        required: ['path']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'search_files',
      description: 'Регулярный поиск по тексту файлов (node_modules/.git и двоичные пропускаются).',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Папка, в которой искать.' },
          pattern: { type: 'string', description: 'Регулярное выражение (JavaScript).' },
          glob: { type: 'string', description: 'Фильтр имён файлов, например *.ts (необязательно).' }
        },
        required: ['path', 'pattern']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Создать или полностью перезаписать файл (папки создаются автоматически).',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Путь к файлу.' },
          content: { type: 'string', description: 'Полное новое содержимое файла.' }
        },
        required: ['path', 'content']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'edit_file',
      description:
        'Точечная замена в файле: заменить old_string на new_string. old_string должен встречаться один раз (или задайте replace_all).',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Путь к файлу.' },
          old_string: { type: 'string', description: 'Фрагмент, который нужно заменить (точно, с отступами).' },
          new_string: { type: 'string', description: 'Чем заменить.' },
          replace_all: { type: 'boolean', description: 'Заменить все вхождения.' }
        },
        required: ['path', 'old_string', 'new_string']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'run_command',
      description:
        'Выполнить команду в терминале Windows (PowerShell или cmd) и получить вывод и код возврата. Для сборок, тестов, запуска скриптов.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Командная строка.' },
          shell: { type: 'string', enum: ['powershell', 'cmd'], description: 'Оболочка (по умолчанию из настроек).' },
          cwd: { type: 'string', description: 'Рабочая папка команды (по умолчанию папка агента).' },
          timeout_sec: { type: 'integer', description: 'Тайм-аут в секундах.' }
        },
        required: ['command']
      }
    }
  }
]
