// Чистые помощники режима агента: подписи инструментов, разбор аргументов, diff, слияние снимков шагов.
import type { AgentShell, AgentApproval } from '@shared/config'
import type { AgentTurn, ToolCallRecord, ToolCallStatus } from '@shared/types'

export type ToolKind = 'read' | 'list' | 'search' | 'write' | 'edit' | 'command' | 'other'

export function toolKind(name: string): ToolKind {
  switch (name) {
    case 'read_file':
      return 'read'
    case 'list_dir':
      return 'list'
    case 'search_files':
      return 'search'
    case 'write_file':
      return 'write'
    case 'edit_file':
      return 'edit'
    case 'run_command':
      return 'command'
    default:
      return 'other'
  }
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v : undefined)

/** Оболочка команды: из аргументов вызова, иначе — терминал по умолчанию из настроек. */
export function commandShell(call: ToolCallRecord, fallback: AgentShell = 'powershell'): AgentShell {
  const s = str(call.args.shell)?.toLowerCase()
  if (s === 'cmd' || s === 'cmd.exe') return 'cmd'
  if (s && s.includes('powershell')) return 'powershell'
  if (s === 'pwsh') return 'powershell'
  return fallback
}

export const SHELL_LABEL: Record<AgentShell, string> = { powershell: 'PowerShell', cmd: 'cmd' }

/** Подпись действия в карточке: «Прочитан файл», «Команда (PowerShell)». */
export function toolVerb(call: ToolCallRecord, shell: AgentShell = 'powershell'): string {
  switch (toolKind(call.name)) {
    case 'read':
      return 'Прочитан файл'
    case 'list':
      return 'Содержимое папки'
    case 'search':
      return 'Поиск'
    case 'write':
      return 'Записан файл'
    case 'edit':
      return 'Изменён файл'
    case 'command':
      return `Команда (${SHELL_LABEL[commandShell(call, shell)]})`
    default:
      return call.name
  }
}

/** Что агент собирается сделать (заголовок карточки подтверждения). */
export function toolIntent(call: ToolCallRecord, shell: AgentShell = 'powershell'): string {
  switch (toolKind(call.name)) {
    case 'write':
      return 'Агент хочет записать файл'
    case 'edit':
      return 'Агент хочет изменить файл'
    case 'command':
      return `Агент хочет выполнить команду (${SHELL_LABEL[commandShell(call, shell)]})`
    case 'read':
      return 'Агент хочет прочитать файл'
    case 'list':
      return 'Агент хочет посмотреть содержимое папки'
    case 'search':
      return 'Агент хочет выполнить поиск'
    default:
      return `Агент хочет вызвать ${call.name}`
  }
}

/** Главный аргумент вызова: путь, команда или строка поиска. */
export function toolSubject(call: ToolCallRecord): string {
  const a = call.args
  const kind = toolKind(call.name)
  if (kind === 'command') return str(a.command) ?? str(a.cmd) ?? ''
  if (kind === 'search') {
    const q = str(a.query) ?? str(a.pattern) ?? str(a.regex) ?? str(a.text) ?? ''
    const where = str(a.path) ?? str(a.dir)
    const glob = str(a.glob) ?? str(a.include)
    return [q && `«${q}»`, glob, where && `в ${where}`].filter(Boolean).join(' ')
  }
  return str(a.path) ?? str(a.file) ?? str(a.file_path) ?? str(a.dir) ?? str(a.directory) ?? (kind === 'list' ? '.' : '')
}

/** Путь внутри рабочей папки показываем относительным: «src\index.ts» вместо полного. */
export function relativeTo(path: string, cwd: string | undefined): string {
  if (!cwd) return path
  const base = cwd.replace(/[\\/]+$/, '')
  if (!base) return path
  const lower = path.toLowerCase()
  const b = base.toLowerCase()
  if (lower === b) return '.'
  if (lower.startsWith(b) && /[\\/]/.test(path.charAt(base.length))) return path.slice(base.length + 1)
  return path
}

/** Последний сегмент пути: имя папки для подписи. */
export function baseName(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '')
  const i = Math.max(trimmed.lastIndexOf('\\'), trimmed.lastIndexOf('/'))
  return i >= 0 ? trimmed.slice(i + 1) || trimmed : trimmed
}

/** Похоже ли значение на путь (для усечения из середины, а не с конца). */
export const isPathLike = (s: string): boolean => /[\\/]/.test(s) && !/\s{2,}|\n/.test(s)

/** Усечение из середины: «D:\Projects\…\src\index.ts». */
export function truncateMiddle(s: string, max: number): string {
  if (s.length <= max) return s
  if (max < 5) return s.slice(0, max)
  const keepEnd = Math.ceil((max - 1) * 0.6)
  const keepStart = max - 1 - keepEnd
  return `${s.slice(0, keepStart)}…${s.slice(s.length - keepEnd)}`
}

export const STATUS_LABEL: Record<ToolCallStatus, string> = {
  pending: 'В очереди',
  checking: 'Проверяется охранником',
  awaitingApproval: 'Ждёт подтверждения',
  running: 'Выполняется',
  done: 'Готово',
  error: 'Ошибка',
  denied: 'Отклонено'
}

export const isBusyStatus = (s: ToolCallStatus): boolean => s === 'checking' || s === 'running' || s === 'pending'

/** Длительность: 380 → «0,4 с», 12500 → «13 с», 75000 → «1 мин 15 с». */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return ''
  if (ms < 1000) return `${(Math.max(ms, 50) / 1000).toFixed(1).replace('.', ',')} с`
  if (ms < 10_000) return `${(ms / 1000).toFixed(1).replace('.', ',')} с`
  const sec = Math.round(ms / 1000)
  if (sec < 60) return `${sec} с`
  const m = Math.floor(sec / 60)
  const rest = sec % 60
  return rest ? `${m} мин ${rest} с` : `${m} мин`
}

export type DiffLineKind = 'add' | 'del' | 'hunk' | 'meta' | 'ctx'

export function diffLineKind(line: string): DiffLineKind {
  if (line.startsWith('+++') || line.startsWith('---')) return 'meta'
  if (line.startsWith('@@')) return 'hunk'
  if (line.startsWith('+')) return 'add'
  if (line.startsWith('-')) return 'del'
  if (/^(diff |index |\\ No newline)/.test(line)) return 'meta'
  return 'ctx'
}

/** Число добавленных и удалённых строк в unified diff. */
export function diffStat(diff: string): { added: number; removed: number } {
  let added = 0
  let removed = 0
  for (const line of diff.split('\n')) {
    const k = diffLineKind(line)
    if (k === 'add') added++
    else if (k === 'del') removed++
  }
  return { added, removed }
}

/** Первые строки текста для короткого предпросмотра. */
export function previewLines(text: string, maxLines: number): { text: string; more: number } {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  if (lines.length <= maxLines) return { text: lines.join('\n'), more: 0 }
  return { text: lines.slice(0, maxLines).join('\n'), more: lines.length - maxLines }
}

/** Вызовы инструментов, ждущие решения пользователя. */
export function awaitingCalls(turns: AgentTurn[] | undefined): ToolCallRecord[] {
  if (!turns) return []
  return turns.flatMap((t) => t.toolCalls.filter((c) => c.status === 'awaitingApproval'))
}

/** Шаги нового снимка с учётом уже пришедшего потоком текста текущего шага.
 *  Снимок авторитетен, но если в нём текст шага короче накопленного дельтами (снимок сделан раньше),
 *  оставляем более длинный — иначе текст на экране «откатится» до следующей дельты. */
export function mergeTurns(local: AgentTurn[] | undefined, snapshot: AgentTurn[]): AgentTurn[] {
  if (!local?.length) return snapshot
  return snapshot.map((t, i) => {
    const l = local[i]
    if (!l) return t
    const content = l.content.length > t.content.length && l.content.startsWith(t.content) ? l.content : t.content
    const lr = l.reasoning ?? ''
    const tr = t.reasoning ?? ''
    const reasoning = lr.length > tr.length && lr.startsWith(tr) ? lr : t.reasoning
    return content === t.content && reasoning === t.reasoning ? t : { ...t, content, reasoning }
  })
}

/** Дописать дельту в текущий (последний) шаг. */
export function appendToLastTurn(turns: AgentTurn[], content?: string, reasoning?: string): AgentTurn[] {
  if (!turns.length) return [{ content: content ?? '', reasoning: reasoning || undefined, toolCalls: [] }]
  const next = turns.slice()
  const last = { ...next[next.length - 1]! }
  if (content) last.content += content
  if (reasoning) last.reasoning = (last.reasoning ?? '') + reasoning
  next[next.length - 1] = last
  return next
}

export const APPROVAL_OPTIONS: Array<{ value: AgentApproval; label: string; description: string }> = [
  {
    value: 'askDangerous',
    label: 'Спрашивать только опасное',
    description: 'Чтение и безопасные действия выполняются сразу, рискованные записи и команды — после вашего подтверждения.'
  },
  {
    value: 'askAll',
    label: 'Спрашивать каждую запись и команду',
    description: 'Без вопросов агент только читает файлы и ищет. Любую запись файла и любую команду вы подтверждаете.'
  },
  {
    value: 'auto',
    label: 'Полный автомат',
    description: 'Агент действует без вопросов. Подходит для папок, которые не жалко, например для копии проекта.'
  }
]

/** Подсказка под полем ввода в режиме агента. */
export function agentHint(approval: AgentApproval, allowAll: boolean): string {
  const base = 'Агент читает и меняет файлы в рабочей папке и запускает команды.'
  if (allowAll) return `${base} В этом чате разрешено всё, кроме опасного по жёстким правилам.`
  switch (approval) {
    case 'askAll':
      return `${base} Каждую запись и команду — с вашего подтверждения.`
    case 'auto':
      return `${base} Без вопросов, кроме опасного по жёстким правилам.`
    default:
      return `${base} Опасные действия — с вашего подтверждения.`
  }
}

export const AGENT_EXAMPLES = [
  'Создай в папке проекта файл README с описанием',
  'Найди все TODO в проекте и перечисли их',
  'Запусти тесты и исправь упавшие'
]
