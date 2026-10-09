// Мелкие текстовые помощники для страниц.

/** Русское множественное число: plural(5, ['модель', 'модели', 'моделей']) → 'моделей'. */
export function plural(n: number, forms: [string, string, string]): string {
  const a = Math.abs(n)
  const m10 = a % 10
  const m100 = a % 100
  if (m10 === 1 && m100 !== 11) return forms[0]
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return forms[1]
  return forms[2]
}

/** Папка, в которой лежит файл (Windows и POSIX пути). */
export function dirOf(path: string): string {
  const i = Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/'))
  return i > 0 ? path.slice(0, i) : path
}

/** Текст ошибки из чего угодно. */
export function errText(e: unknown): string {
  if (e instanceof Error) return e.message
  return String(e)
}

/** Ошибка «нет обработчика IPC» → понятный текст (модуль ещё не подключён в этой сборке). */
export function friendlyError(e: unknown): string {
  const msg = errText(e)
  if (/No handler registered/i.test(msg)) return 'Эта функция пока недоступна в этой сборке приложения.'
  return msg
}

/** Длительность в секундах → «≈ 3 мин», «≈ 1 ч 20 мин». */
export function formatEta(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return ''
  if (seconds < 60) return `≈ ${Math.max(1, Math.round(seconds))} с`
  const m = Math.round(seconds / 60)
  if (m < 60) return `≈ ${m} мин`
  const h = Math.floor(m / 60)
  const rest = m % 60
  return rest ? `≈ ${h} ч ${rest} мин` : `≈ ${h} ч`
}

/** Число с разделителями разрядов: 131072 → «131 072». */
export const formatInt = (n: number): string => Math.round(n).toLocaleString('ru-RU')
