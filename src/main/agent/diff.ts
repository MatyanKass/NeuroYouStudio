// Простой unified diff по строкам (без зависимостей) для предпросмотра правок файлов.

interface Op {
  kind: 'eq' | 'del' | 'add'
  line: string
}

/** Последовательность операций diff через наибольшую общую подпоследовательность строк. */
function diffOps(a: string[], b: string[]): Op[] {
  const n = a.length
  const m = b.length
  // Таблица длин LCS. При очень больших файлах таблица была бы огромной — ограничиваем выше по стеку.
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!)
    }
  }
  const ops: Op[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ kind: 'eq', line: a[i]! })
      i++
      j++
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      ops.push({ kind: 'del', line: a[i]! })
      i++
    } else {
      ops.push({ kind: 'add', line: b[j]! })
      j++
    }
  }
  while (i < n) ops.push({ kind: 'del', line: a[i++]! })
  while (j < m) ops.push({ kind: 'add', line: b[j++]! })
  return ops
}

const MAX_DIFF_LINES = 4000

/** Unified diff. Для огромных файлов — краткая сводка вместо построчного сравнения. */
export function unifiedDiff(oldText: string, newText: string, path: string, maxChars = 4000): string {
  if (oldText === newText) return ''
  const a = oldText.length ? oldText.split('\n') : []
  const b = newText.length ? newText.split('\n') : []
  if (a.length > MAX_DIFF_LINES || b.length > MAX_DIFF_LINES) {
    return `--- ${path}\n+++ ${path}\n@@ файл слишком большой для построчного сравнения @@\n- строк было: ${a.length}\n+ строк стало: ${b.length}`
  }
  const ops = diffOps(a, b)
  const lines: string[] = [`--- ${path}`, `+++ ${path}`]
  const ctx = 3
  // Группируем изменения в блоки, разделённые ≥ (2*ctx+1) одинаковыми строками.
  let group: Op[] = []
  let sinceChange = Infinity
  const groups: Op[][] = []
  for (const op of ops) {
    if (op.kind === 'eq') {
      sinceChange++
      if (sinceChange > 2 * ctx && group.some((o) => o.kind !== 'eq')) {
        groups.push(group)
        group = []
      }
      group.push(op)
    } else {
      sinceChange = 0
      group.push(op)
    }
  }
  if (group.some((o) => o.kind !== 'eq')) groups.push(group)

  for (const g of groups) {
    // Обрезаем лишний контекст по краям группы.
    let start = 0
    while (start < g.length && g[start]!.kind === 'eq' && start < g.findIndex((o) => o.kind !== 'eq') - ctx) start++
    let end = g.length
    const lastChange = g.map((o) => o.kind !== 'eq').lastIndexOf(true)
    while (end > lastChange + 1 + ctx) end--
    const slice = g.slice(start, end)
    const delN = slice.filter((o) => o.kind !== 'add').length
    const addN = slice.filter((o) => o.kind !== 'del').length
    lines.push(`@@ -${delN} +${addN} @@`)
    for (const o of slice) lines.push(`${o.kind === 'del' ? '-' : o.kind === 'add' ? '+' : ' '}${o.line}`)
  }

  let out = lines.join('\n')
  if (out.length > maxChars) out = `${out.slice(0, maxChars)}\n… (diff усечён)`
  return out
}
