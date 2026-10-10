// Политика агента: детерминированные жёсткие правила + (опционально) модель-охранник.
// Правила проверяют только действия с побочными эффектами (write_file/edit_file/run_command);
// read-only инструменты сюда не попадают.
import type { GuardVerdict } from '@shared/types'
import { isInside, resolvePath } from './tools'

type Level = GuardVerdict['level']

/** max(safe < ask < block). */
const RANK: Record<Level, number> = { safe: 0, ask: 1, block: 2 }
export const maxLevel = (a: Level, b: Level): Level => (RANK[a] >= RANK[b] ? a : b)

/** Нормализация команды/пути для сопоставления: нижний регистр, прямые слэши, развёрнутые переменные. */
function normalize(text: string): string {
  let s = text.toLowerCase().replace(/\\/g, '/')
  // Переменные окружения Windows → примерные корни (для сопоставления с системными путями).
  s = s
    .replace(/%systemroot%|%windir%|\$env:systemroot|\$env:windir/g, 'c:/windows')
    .replace(/%programfiles(\(x86\))?%|\$env:programfiles(\(x86\))?/g, 'c:/program files')
    .replace(/%userprofile%|\$env:userprofile|\$home|~(?=\/)/g, 'c:/users/_user')
    .replace(/%systemdrive%|\$env:systemdrive/g, 'c:')
  return s
}

// Системные папки, куда запись/удаление недопустимы.
const SYSTEM_DIR_RE = /(^|[^a-z0-9])c:\/(windows|program files( \(x86\))?)(\/|$|[^a-z0-9])/

// Корни, рекурсивное удаление которых катастрофично (диск, система, корень профиля).
const DESTRUCTIVE_ROOT_RE =
  /(^|["'\s=])(c:\/?(\s|$|["'])|c:\/windows|c:\/program files( \(x86\))?|c:\/users(\/[^/\s"']+)?\/?(\s|$|["']))/

// Рекурсивное/массовое удаление.
const RECURSIVE_DELETE_RE = /(remove-item|ri|rm|rd|rmdir|del|erase)\b[^\n|]*(-recurse|-r\b|\/s\b|-rf\b)/

/** Жёсткие правила: block — катастрофа/система, ask — обратимо-рискованное, safe — остальное. */
export function rulesVerdict(tool: string, args: Record<string, unknown>, cwd: string): GuardVerdict {
  if (tool === 'write_file' || tool === 'edit_file') return fileRules(args, cwd)
  if (tool === 'run_command') return commandRules(args, cwd)
  return { level: 'safe', reason: '', by: 'rules' }
}

function fileRules(args: Record<string, unknown>, cwd: string): GuardVerdict {
  const raw = typeof args.path === 'string' ? args.path : ''
  let abs: string
  try {
    abs = resolvePath(cwd, raw)
  } catch {
    return { level: 'ask', reason: 'Не удалось разобрать путь файла.', by: 'rules' }
  }
  const norm = normalize(abs)
  if (SYSTEM_DIR_RE.test(norm)) {
    return { level: 'block', reason: 'Запись в системную папку Windows/Program Files.', by: 'rules' }
  }
  if (!isInside(cwd, abs)) {
    return { level: 'ask', reason: 'Запись вне рабочей папки.', by: 'rules' }
  }
  return { level: 'safe', reason: '', by: 'rules' }
}

interface Rule {
  re: RegExp
  level: Level
  reason: string
}

// Порядок: сначала block-правила, затем ask-правила.
const BLOCK_RULES: Rule[] = [
  { re: /\b(format)\s+[a-z]:/, level: 'block', reason: 'Форматирование диска.' },
  { re: /\bdiskpart\b/, level: 'block', reason: 'diskpart — операции с разделами диска.' },
  { re: /\bbcdedit\b/, level: 'block', reason: 'Изменение загрузчика Windows.' },
  { re: /\breg(\.exe)?\s+(delete|add)\b|\b(remove|set|new)-itemproperty\b.*hk(lm|cu|cr)|\bhklm:|\bhkcu:/, level: 'block', reason: 'Правка реестра Windows.' },
  { re: /\b(shutdown|restart-computer|stop-computer)\b/, level: 'block', reason: 'Выключение или перезагрузка компьютера.' },
  { re: /\b(set|add)-mppreference\b|disablerealtimemonitoring|\bsc(\.exe)?\s+(stop|delete)\s+windefend|uninstall-windowsfeature/, level: 'block', reason: 'Отключение защиты Windows (Defender).' },
  { re: /(invoke-webrequest|iwr|curl|wget|downloadstring|invoke-restmethod|irm)\b[^\n]*\|\s*(iex|invoke-expression|cmd|powershell|sh|bash)\b/, level: 'block', reason: 'Скачивание и немедленный запуск кода.' },
  { re: /\binvoke-expression\b[^\n]*(downloadstring|webclient|webrequest)|\biex\s*\(/, level: 'block', reason: 'Исполнение загруженного из сети кода.' },
  { re: /(taskkill[^\n]*\/im\s+(lsass|winlogon|csrss|services|smss|wininit|svchost))|stop-process[^\n]*\b(lsass|winlogon|csrss|services|smss|wininit|svchost)\b/, level: 'block', reason: 'Остановка системного процесса.' }
]

const ASK_RULES: Rule[] = [
  { re: /\bgit\s+push\b/, level: 'ask', reason: 'git push — отправка изменений на сервер.' },
  { re: /\bnpm\s+(i|install|add)\b[^\n]*\s-g\b|\bnpm\s+(i|install)\s+-g\b|-g\s+install/, level: 'ask', reason: 'Глобальная установка npm-пакета.' },
  { re: /\bpip\d?\s+install\b|\bpip\d?\s+uninstall\b/, level: 'ask', reason: 'Установка/удаление Python-пакета.' },
  { re: /\b(winget|choco|scoop)\s+(install|uninstall|upgrade)\b/, level: 'ask', reason: 'Установка программ через пакетный менеджер.' },
  { re: /(curl|iwr|invoke-webrequest|invoke-restmethod)\b[^\n]*(-t\b|--upload|-method\s+(post|put)|-infile)/, level: 'ask', reason: 'Передача данных по сети.' },
  { re: /\bscp\b|\bftp\b|\brsync\b/, level: 'ask', reason: 'Передача файлов по сети.' }
]

function commandRules(args: Record<string, unknown>, cwd: string): GuardVerdict {
  const command = typeof args.command === 'string' ? args.command : ''
  const norm = normalize(command)

  for (const r of BLOCK_RULES) if (r.re.test(norm)) return { level: 'block', reason: r.reason, by: 'rules' }

  // Рекурсивное удаление опасных корней — block; прочее рекурсивное/внешнее удаление — ask.
  if (RECURSIVE_DELETE_RE.test(norm)) {
    if (DESTRUCTIVE_ROOT_RE.test(norm)) {
      return { level: 'block', reason: 'Рекурсивное удаление системной папки или корня диска.', by: 'rules' }
    }
    return { level: 'ask', reason: 'Рекурсивное удаление файлов.', by: 'rules' }
  }

  for (const r of ASK_RULES) if (r.re.test(norm)) return { level: 'ask', reason: r.reason, by: 'rules' }

  // Удаление/перемещение с путём вне рабочей папки.
  const delMove = /\b(remove-item|del|erase|move-item|move|mv|copy-item|robocopy)\b\s+(.+)/.exec(command)
  if (delMove && /\b(remove-item|del|erase|move-item|move|mv)\b/i.test(delMove[0])) {
    for (const tok of extractPaths(delMove[2] ?? '')) {
      try {
        if (!isInside(cwd, resolvePath(cwd, tok))) {
          return { level: 'ask', reason: 'Удаление или перемещение вне рабочей папки.', by: 'rules' }
        }
      } catch {
        // неразбираемый токен пропускаем
      }
    }
  }

  return { level: 'safe', reason: '', by: 'rules' }
}

/** Грубое извлечение путей-аргументов (без флагов, кавычки снимаются). */
function extractPaths(tail: string): string[] {
  const out: string[] = []
  const re = /"([^"]+)"|'([^']+)'|(\S+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(tail))) {
    const tok = m[1] ?? m[2] ?? m[3] ?? ''
    if (!tok || tok.startsWith('-') || tok.startsWith('/')) continue
    if (/[\\/]|:|\.\w/.test(tok)) out.push(tok)
  }
  return out
}

export interface GuardAsk {
  userRequest: string
  cwd: string
  tool: string
  args: Record<string, unknown>
  /** diff/первые-последние строки содержимого для записей (если есть). */
  preview?: string
}

/** Запрос к модели-охраннику. Возвращает вердикт или null при недоступности/ошибке. */
export type GuardFn = (ask: GuardAsk) => Promise<GuardVerdict | null>

export interface EvaluateInput {
  tool: string
  args: Record<string, unknown>
  cwd: string
  userRequest: string
  preview?: string
  guardEnabled: boolean
  guard?: GuardFn
}

/**
 * Итоговый вердикт по действию: max(правила, охранник).
 * Если охранник включён, но недоступен/ошибся — неизвестное считаем «ask», не «safe».
 */
export async function evaluateAction(input: EvaluateInput): Promise<GuardVerdict> {
  const rules = rulesVerdict(input.tool, input.args, input.cwd)
  if (!input.guardEnabled || !input.guard) return rules
  // Жёсткий block не требует мнения охранника.
  if (rules.level === 'block') return rules

  let guard: GuardVerdict | null
  try {
    guard = await input.guard({
      userRequest: input.userRequest,
      cwd: input.cwd,
      tool: input.tool,
      args: input.args,
      preview: input.preview
    })
  } catch {
    guard = null
  }
  if (!guard) {
    // Охранник не ответил: не понижаем ниже «ask».
    return maxLevel(rules.level, 'ask') === rules.level && rules.level !== 'safe'
      ? rules
      : { level: maxLevel(rules.level, 'ask'), reason: 'Охранник недоступен — требуется подтверждение.', by: 'guard' }
  }
  const level = maxLevel(rules.level, guard.level)
  if (level === guard.level && guard.level !== rules.level) return { ...guard, level }
  if (level === rules.level && rules.level !== 'safe') return rules
  return { level, reason: guard.reason || rules.reason, by: level === guard.level ? 'guard' : 'rules' }
}
