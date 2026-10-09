// Детали модели HF: варианты загрузки, «уже скачано», оценка «влезет ли».
import { promises as fs } from 'node:fs'
import type { ModelFormat } from '@shared/config'
import type { HardwareInfo, HfModelDetails } from '@shared/types'
import { HfError, type HfClient, type HfModelInfo } from './client'
import { estimateFit, hardwareKnown } from './fit'
import {
  buildExl3Option,
  fileTarget,
  groupGgufOptions,
  readmeExcerpt,
  splitRepoId,
  treeFiles,
  type Exl3QuantConfig,
  type RichOption
} from './options'

export interface DetailsDeps {
  client: HfClient
  modelsDir: string
  hardware?: HardwareInfo | null
  /** Сколько веток EXL3 запрашивать параллельно. */
  concurrency?: number
}

export interface DetailsResult extends HfModelDetails {
  options: RichOption[]
  mmproj: RichOption[]
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length)
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i] as T)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return out
}

async function readQuantConfig(client: HfClient, repoId: string, rev: string): Promise<Exl3QuantConfig | undefined> {
  const text = await client.fileText(repoId, rev, 'config.json')
  if (!text) return undefined
  try {
    const cfg = JSON.parse(text) as { quantization_config?: Exl3QuantConfig }
    return cfg.quantization_config && typeof cfg.quantization_config === 'object' ? cfg.quantization_config : undefined
  } catch {
    return undefined
  }
}

/** Варианты EXL3: по одному на ветку (+ main, если там сами EXL3-веса). */
export async function exl3Options(
  client: HfClient,
  repoId: string,
  info: HfModelInfo,
  concurrency = 4
): Promise<RichOption[]> {
  const refs = await client.refs(repoId).catch((e: unknown) => {
    if (e instanceof HfError && !e.retryable) return { branches: [{ name: 'main', targetCommit: info.sha }] }
    throw e
  })
  const branches = refs.branches.length ? refs.branches : [{ name: 'main', targetCommit: info.sha }]
  const { name: repoName } = splitRepoId(repoId)
  const errors: unknown[] = []
  const results = await mapLimit(branches, concurrency, async (b) => {
    try {
      const files = treeFiles(await client.tree(repoId, b.name))
      if (!files.some((f) => /\.safetensors$/i.test(f.path))) return null
      let quantConfig: Exl3QuantConfig | undefined
      const isMain = b.name === 'main'
      if (isMain || !/bpw/i.test(b.name)) {
        if (!files.some((f) => f.path === 'config.json')) return null
        quantConfig = await readQuantConfig(client, repoId, b.name)
        if (isMain && quantConfig?.quant_method !== 'exl3') return null
      }
      return buildExl3Option({ name: b.name, commit: b.targetCommit, files, quantConfig }, repoName)
    } catch (e) {
      errors.push(e)
      return null
    }
  })
  const options = results.filter((o): o is RichOption => o !== null)
  if (!options.length && errors.length) throw errors[0]
  return options.sort((a, b) => a.sizeBytes - b.sizeBytes || a.key.localeCompare(b.key))
}

async function fileComplete(path: string, size: number): Promise<boolean> {
  try {
    const st = await fs.stat(path)
    return st.isFile() && st.size === size
  } catch {
    return false
  }
}

/** Отмечает варианты, все файлы которых уже лежат на диске целиком. */
export async function markDownloaded(
  options: RichOption[],
  modelsDir: string,
  repoId: string,
  format: ModelFormat
): Promise<void> {
  await Promise.all(
    options.map(async (o) => {
      if (!o.files.length) return
      const checks = await Promise.all(
        o.files.map((f) => fileComplete(fileTarget(modelsDir, repoId, format, o.revision, f.path), f.size))
      )
      o.downloaded = checks.every(Boolean)
    })
  )
}

export async function fetchModelDetails(deps: DetailsDeps, repoId: string, format: ModelFormat): Promise<DetailsResult> {
  const { client } = deps
  const info = await client.modelInfo(repoId)
  const id = info.id || repoId
  const readmeP = client.readme(id).catch(() => '')

  let options: RichOption[]
  let mmproj: RichOption[] = []
  if (format === 'gguf') {
    const grouped = groupGgufOptions(treeFiles(await client.tree(id, 'main')), 'main', info.sha)
    options = grouped.options
    mmproj = grouped.mmproj
  } else {
    options = await exl3Options(client, id, info, deps.concurrency ?? 4)
  }

  await markDownloaded([...options, ...mmproj], deps.modelsDir, id, format)
  if (hardwareKnown(deps.hardware)) {
    for (const o of options) {
      const est = estimateFit(o.sizeBytes, format, deps.hardware)
      o.fit = est.fit
      o.fitNote = est.note
    }
  }

  return {
    id,
    format,
    description: readmeExcerpt(await readmeP),
    options,
    mmproj,
    gated: Boolean(info.gated)
  }
}
