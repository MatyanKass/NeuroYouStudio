import { app } from 'electron'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import os from 'node:os'
import { getHardwareInfo } from './hardware'
import { engineStatus } from './engines/manager'
import { listModels } from './models/registry'
import { getSettings } from './settings'
import { logsDir, runtimesDir } from './paths'

async function lastLogLines(n: number): Promise<string[]> {
  try {
    const dir = logsDir()
    const files = (await fs.readdir(dir)).filter((f) => f.endsWith('.log'))
    const stats = await Promise.all(files.map(async (f) => ({ f, t: (await fs.stat(join(dir, f))).mtimeMs })))
    const latest = stats.sort((a, b) => b.t - a.t)[0]
    if (!latest) return []
    const text = await fs.readFile(join(dir, latest.f), 'utf8')
    return text.split(/\r?\n/).slice(-n)
  } catch {
    return []
  }
}

/** Текстовый отчёт для отправки разработчику: железо, настройки, движок, последние строки лога. */
export async function buildDiagnostics(): Promise<string> {
  const hw = await getHardwareInfo(true).catch(() => null)
  const s = getSettings()
  const status = engineStatus()
  const models = await listModels(false).catch(() => [])
  const runtimes = await fs.readdir(runtimesDir()).catch(() => [] as string[])
  const lines: string[] = []
  const push = (k: string, v: unknown): void => {
    lines.push(`${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`)
  }

  lines.push('=== NeuroYouStudio — диагностика ===')
  push('Версия', app.getVersion())
  push('Дата', new Date().toISOString())
  push('ОС', `${os.type()} ${os.release()} ${os.arch()}`)
  push('Electron', process.versions.electron)
  lines.push('')
  lines.push('--- Железо ---')
  if (hw) {
    for (const g of hw.gpus) {
      push(`GPU ${g.index}`, `${g.name}, ${g.vramTotalMiB} МиБ (свободно ${g.vramFreeMiB}), драйвер ${g.driverVersion}, CC ${g.computeCap}`)
    }
    if (!hw.gpus.length) push('GPU', 'NVIDIA не найдена')
    push('CPU', `${hw.cpuName}, ${hw.cpuCores} ядер / ${hw.cpuThreads} потоков, AVX2=${hw.avx2}, AVX-512=${hw.avx512}`)
    push('RAM', `${hw.ramTotalMiB} МиБ (свободно ${hw.ramFreeMiB})`)
    if (hw.cudaVersion) push('CUDA (драйвер)', hw.cudaVersion)
  }
  lines.push('')
  lines.push('--- Движки ---')
  push('Установлены', runtimes.filter((r) => !r.startsWith('.')))
  push('Выбраны', s.selectedRuntimes)
  push('Движок GGUF по умолчанию', s.defaultEngineGguf)
  push('Защита от перегрузки', s.guardrails)
  lines.push('')
  lines.push('--- Состояние ---')
  push('Статус', status.state)
  if (status.engine) push('Движок', `${status.engine} (${status.runtimeId ?? '?'})`)
  if (status.modelId) push('Модель', status.modelId)
  if (status.error) push('Ошибка', status.error)
  if (status.load) push('Настройки загрузки', status.load)
  if (status.plan) {
    push('План: VRAM / RAM, МиБ', `${Math.round(status.plan.vramBytes / 2 ** 20)} / ${Math.round(status.plan.ramBytes / 2 ** 20)}`)
    push('Аргументы', status.plan.args.join(' '))
  }
  if (status.actual) push('Факт по логам, МиБ', status.actual)
  lines.push('')
  lines.push(`--- Модели (${models.length}) ---`)
  for (const m of models.slice(0, 40)) {
    lines.push(`${m.id} | ${m.format} | ${m.quant} | ${Math.round(m.sizeBytes / 2 ** 20)} МиБ${m.error ? ` | ошибка: ${m.error}` : ''}`)
  }
  lines.push('')
  lines.push('--- Последние строки лога движка ---')
  lines.push(...(await lastLogLines(150)))
  return lines.join('\n')
}
