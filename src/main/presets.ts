import { dialog } from 'electron'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import type { Preset } from '@shared/types'
import { presetsDir } from './paths'
import { readJson, writeJson } from './util/json-file'
import { newId } from './util/id'
import { handle } from './ipc'

const BUILTIN: Preset[] = [
  {
    id: 'builtin-precise',
    name: 'Точный (код, факты)',
    prediction: { temperature: 0.2, topK: 20, topP: { enabled: true, value: 0.9 }, minP: { enabled: true, value: 0.05 } },
    createdAt: 0,
    updatedAt: 0
  },
  {
    id: 'builtin-creative',
    name: 'Творческий',
    prediction: {
      temperature: 1.0,
      topK: 0,
      topP: { enabled: true, value: 0.95 },
      minP: { enabled: true, value: 0.05 },
      xtcProbability: { enabled: true, value: 0.5 },
      xtcThreshold: { enabled: true, value: 0.1 }
    },
    createdAt: 0,
    updatedAt: 0
  }
]

const fileOf = (id: string): string => join(presetsDir(), `${id.replace(/[^\w-]/g, '')}.json`)

export async function listPresets(): Promise<Preset[]> {
  const files = await fs.readdir(presetsDir()).catch(() => [] as string[])
  const user: Preset[] = []
  for (const f of files) {
    if (!f.endsWith('.json')) continue
    const p = await readJson<Preset | null>(join(presetsDir(), f), null)
    if (p?.id && p.name) user.push(p)
  }
  user.sort((a, b) => a.name.localeCompare(b.name, 'ru'))
  return [...BUILTIN, ...user]
}

export async function savePreset(p: Preset): Promise<Preset[]> {
  if (!p || typeof p !== 'object') throw new Error('Некорректный пресет')
  const id = typeof p.id === 'string' && /^[\w-]{1,128}$/.test(p.id) ? p.id : newId('p')
  if (id.startsWith('builtin-')) throw new Error('Встроенный пресет нельзя изменить — сохраните как новый')
  const now = Date.now()
  const preset: Preset = {
    ...p,
    id,
    name: typeof p.name === 'string' && p.name.trim() ? p.name.trim() : 'Пресет',
    prediction: p.prediction && typeof p.prediction === 'object' ? p.prediction : {},
    createdAt: p.createdAt || now,
    updatedAt: now
  }
  await writeJson(fileOf(preset.id), preset)
  return listPresets()
}

export async function deletePreset(id: string): Promise<Preset[]> {
  if (typeof id === 'string' && /^[\w-]{1,128}$/.test(id) && !id.startsWith('builtin-')) {
    await fs.rm(fileOf(id), { force: true })
  }
  return listPresets()
}

export function registerPresetsIpc(): void {
  handle('presets:list', () => listPresets())
  handle('presets:save', (p) => savePreset(p))
  handle('presets:delete', (id) => deletePreset(id))
  handle('presets:import', async () => {
    const res = await dialog.showOpenDialog({
      title: 'Импорт пресета',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Пресет', extensions: ['json'] }]
    })
    for (const path of res.canceled ? [] : res.filePaths) {
      const raw = await readJson<Partial<Preset> & { operation?: { fields?: unknown } } | null>(path, null)
      if (!raw || typeof raw !== 'object') continue
      await savePreset({
        id: newId('p'),
        name: raw.name || 'Импортированный пресет',
        prediction: raw.prediction ?? {},
        load: raw.load,
        createdAt: 0,
        updatedAt: 0
      })
    }
    return listPresets()
  })
  handle('presets:export', async (id) => {
    const p = (await listPresets()).find((x) => x.id === id)
    if (!p) throw new Error('Пресет не найден')
    const res = await dialog.showSaveDialog({
      title: 'Экспорт пресета',
      defaultPath: `${p.name.replace(/[<>:"/\\|?*]/g, '_')}.json`,
      filters: [{ name: 'Пресет', extensions: ['json'] }]
    })
    if (!res.canceled && res.filePath) await writeJson(res.filePath, { ...p, id: undefined })
  })
}
