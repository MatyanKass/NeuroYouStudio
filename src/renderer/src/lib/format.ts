const GiB = 1024 ** 3
const MiB = 1024 ** 2

export function formatBytes(bytes: number, digits = 1): string {
  if (!Number.isFinite(bytes)) return '—'
  if (Math.abs(bytes) >= GiB) return `${(bytes / GiB).toFixed(digits)} ГБ`
  if (Math.abs(bytes) >= MiB) return `${(bytes / MiB).toFixed(0)} МБ`
  if (Math.abs(bytes) >= 1024) return `${(bytes / 1024).toFixed(0)} КБ`
  return `${bytes} Б`
}

export const formatMiB = (mib: number, digits = 1): string => formatBytes(mib * MiB, digits)

export function formatCount(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`
  return String(n)
}

export function formatRelative(ts: number): string {
  const d = Date.now() - ts
  const m = Math.round(d / 60000)
  if (m < 1) return 'только что'
  if (m < 60) return `${m} мин назад`
  const h = Math.round(m / 60)
  if (h < 24) return `${h} ч назад`
  const days = Math.round(h / 24)
  if (days < 30) return `${days} дн назад`
  return new Date(ts).toLocaleDateString('ru-RU')
}

export function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ')
}
