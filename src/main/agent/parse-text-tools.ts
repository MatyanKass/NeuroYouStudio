// Запасной разбор вызовов инструментов из текста ответа.
// Слабые модели (и модели без tool-шаблона) часто печатают вызов как JSON-блок в тексте,
// а не отдают настоящий tool_calls. Тогда файл не создаётся. Здесь мы распознаём такой JSON,
// превращаем его в вызов инструмента и убираем из видимого текста.

const KNOWN_TOOLS = new Set(['read_file', 'list_dir', 'search_files', 'write_file', 'edit_file', 'run_command'])

export interface ParsedTextCall {
  name: string
  /** Аргументы как JSON-строка (как в настоящем tool_calls). */
  arguments: string
}

/** Конец сбалансированной JSON-структуры, начинающейся на позиции start, или -1. */
function matchBalanced(s: string, start: number): number {
  let depth = 0
  let inStr = false
  let esc = false
  for (let i = start; i < s.length; i++) {
    const c = s[i]
    if (inStr) {
      if (esc) esc = false
      else if (c === '\\') esc = true
      else if (c === '"') inStr = false
      continue
    }
    if (c === '"') inStr = true
    else if (c === '{' || c === '[') depth++
    else if (c === '}' || c === ']') {
      depth--
      if (depth === 0) return i + 1
    }
  }
  return -1
}

function argString(a: unknown): string {
  if (typeof a === 'string') return a.trim() || '{}'
  if (a && typeof a === 'object') return JSON.stringify(a)
  return '{}'
}

/** Достаёт вызовы известных инструментов из разобранного JSON-значения. */
function extractCalls(v: unknown, names: Set<string>): ParsedTextCall[] {
  if (Array.isArray(v)) return v.flatMap((x) => extractCalls(x, names))
  if (!v || typeof v !== 'object') return []
  const o = v as Record<string, unknown>
  if (Array.isArray(o.tool_calls)) return o.tool_calls.flatMap((x) => extractCalls(x, names))
  // Формат OpenAI: { function: { name, arguments } }
  if (o.function && typeof o.function === 'object') {
    const f = o.function as Record<string, unknown>
    const name = typeof f.name === 'string' ? f.name : ''
    return names.has(name) ? [{ name, arguments: argString(f.arguments) }] : []
  }
  // Простые формы: { name|tool, arguments|parameters|args }
  const name = typeof o.name === 'string' ? o.name : typeof o.tool === 'string' ? o.tool : ''
  if (names.has(name)) {
    const args = o.arguments ?? o.parameters ?? o.args ?? o.input ?? {}
    return [{ name, arguments: argString(args) }]
  }
  return []
}

function removeSpans(s: string, spans: Array<[number, number]>): string {
  let out = s
  for (const [a, b] of [...spans].sort((x, y) => y[0] - x[0])) out = out.slice(0, a) + out.slice(b)
  return out
}

/**
 * Находит вызовы инструментов, напечатанные в тексте. Возвращает их и текст без этих вставок.
 * Срабатывает только на JSON с именем известного инструмента — обычные данные не трогает.
 */
export function parseTextToolCalls(
  content: string,
  known: Iterable<string> = KNOWN_TOOLS
): { calls: ParsedTextCall[]; cleaned: string } {
  const names = known instanceof Set ? known : new Set(known)
  const calls: ParsedTextCall[] = []
  const spans: Array<[number, number]> = []
  let i = 0
  while (i < content.length) {
    const c = content[i]
    if (c === '{' || c === '[') {
      const end = matchBalanced(content, i)
      if (end > i) {
        let value: unknown
        try {
          value = JSON.parse(content.slice(i, end))
        } catch {
          value = undefined
        }
        if (value !== undefined) {
          const found = extractCalls(value, names)
          if (found.length) {
            calls.push(...found)
            spans.push([i, end])
          }
          i = end
          continue
        }
      }
    }
    i++
  }
  if (!calls.length) return { calls: [], cleaned: content }
  // Убираем JSON и осиротевшие пустые блоки ```…```.
  let cleaned = removeSpans(content, spans)
  cleaned = cleaned.replace(/```[a-zA-Z]*\s*```/g, '').replace(/\n{3,}/g, '\n\n').trim()
  return { calls, cleaned }
}
