import { safeStorage } from 'electron'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import {
  DEFAULT_LOAD_CONFIG,
  DEFAULT_PREDICTION_CONFIG,
  deepMerge,
  type DeepPartial,
  type LoadConfig
} from '@shared/config'
import type { AppSettings } from '@shared/types'
import { defaultModelsDir, userDataDir } from './paths'
import { readJson, writeJson } from './util/json-file'
import { emit } from './ipc'

const settingsPath = (): string => join(userDataDir(), 'settings.json')
const tokenPath = (): string => join(userDataDir(), 'hf-token.bin')

export function defaultSettings(): AppSettings {
  return {
    modelsDir: defaultModelsDir(),
    theme: 'dark',
    fontSize: 'default',
    guardrails: 'balanced',
    defaultEngineGguf: 'auto',
    defaultLoad: DEFAULT_LOAD_CONFIG,
    defaultPrediction: DEFAULT_PREDICTION_CONFIG,
    perModelLoad: {},
    expandReasoning: false,
    hasHfToken: false,
    selectedRuntimes: {},
    ragChunkSize: 512,
    ragChunkOverlap: 100,
    ragTopK: 5,
    imageMaxDimension: 1024,
    onboardingDone: false
  }
}

let current: AppSettings = defaultSettings()

export async function loadSettings(): Promise<AppSettings> {
  const stored = await readJson<DeepPartial<AppSettings>>(settingsPath(), {})
  current = deepMerge(defaultSettings(), stored)
  current.hasHfToken = await fileExists(tokenPath())
  return current
}

export const getSettings = (): AppSettings => current

export async function updateSettings(patch: DeepPartial<AppSettings>): Promise<AppSettings> {
  current = deepMerge(current, patch)
  await writeJson(settingsPath(), current)
  emit('settings:changed', current)
  return current
}

/** Заменяет (а не сливает) настройки загрузки конкретной модели. */
export async function setPerModelLoad(modelId: string, load: Partial<LoadConfig> | null): Promise<AppSettings> {
  const perModelLoad = { ...current.perModelLoad }
  if (load) perModelLoad[modelId] = load
  else delete perModelLoad[modelId]
  current = { ...current, perModelLoad }
  await writeJson(settingsPath(), current)
  emit('settings:changed', current)
  return current
}

/** Настройки загрузки для модели: общие по умолчанию + сохранённые для этой модели. */
export function effectiveLoadConfig(modelId: string): LoadConfig {
  return deepMerge(current.defaultLoad, current.perModelLoad[modelId] as DeepPartial<LoadConfig> | undefined)
}

export async function getHfToken(): Promise<string | null> {
  try {
    const buf = await fs.readFile(tokenPath())
    return safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(buf) : buf.toString('utf8')
  } catch {
    return null
  }
}

export async function setHfToken(token: string | null): Promise<AppSettings> {
  if (token && token.trim()) {
    const t = token.trim()
    const data = safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(t) : Buffer.from(t, 'utf8')
    await fs.writeFile(tokenPath(), data)
  } else {
    await fs.rm(tokenPath(), { force: true })
  }
  return updateSettings({ hasHfToken: Boolean(token && token.trim()) })
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}
