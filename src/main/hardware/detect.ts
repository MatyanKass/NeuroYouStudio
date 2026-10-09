// Определение железа: GPU NVIDIA (nvidia-smi), RAM, CPU, AVX2/AVX-512. Без electron.
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import os from 'node:os'
import { join } from 'node:path'
import type { GpuInfo, HardwareInfo } from '@shared/types'

const MiB = 1024 * 1024

function run(cmd: string, args: string[], timeoutMs = 15000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { windowsHide: true, timeout: timeoutMs, maxBuffer: 4 * MiB }, (err, stdout) => {
      if (err) reject(err)
      else resolve(String(stdout))
    })
  })
}

let smiPath: string | null | undefined

/** Путь к nvidia-smi (PATH, System32, старый NVSMI) или null. */
export function nvidiaSmiPath(): string | null {
  if (smiPath !== undefined) return smiPath
  if (process.platform !== 'win32') return (smiPath = 'nvidia-smi')
  const candidates = [
    join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'nvidia-smi.exe'),
    join(process.env.ProgramFiles ?? 'C:\\Program Files', 'NVIDIA Corporation', 'NVSMI', 'nvidia-smi.exe')
  ]
  smiPath = candidates.find((p) => existsSync(p)) ?? 'nvidia-smi'
  return smiPath
}

/** Разбор `--query-gpu=index,name,memory.total,memory.free,driver_version,compute_cap`. */
export function parseGpuCsv(csv: string): GpuInfo[] {
  const out: GpuInfo[] = []
  for (const line of csv.split(/\r?\n/)) {
    const cols = line.split(',').map((c) => c.trim())
    if (cols.length < 6) continue
    const [index, name, total, free, driver, cc] = cols as [string, string, string, string, string, string]
    const idx = Number(index)
    if (!Number.isFinite(idx)) continue
    out.push({
      index: idx,
      name,
      vramTotalMiB: Number(total) || 0,
      vramFreeMiB: Number(free) || 0,
      driverVersion: driver,
      computeCap: cc
    })
  }
  return out
}

/** "CUDA Version: 13.1" из шапки nvidia-smi. */
export function parseCudaVersion(header: string): string | undefined {
  return /CUDA Version:\s*([\d.]+)/i.exec(header)?.[1]
}

export async function queryGpus(): Promise<GpuInfo[]> {
  const smi = nvidiaSmiPath()
  if (!smi) return []
  try {
    const csv = await run(smi, [
      '--query-gpu=index,name,memory.total,memory.free,driver_version,compute_cap',
      '--format=csv,noheader,nounits'
    ])
    return parseGpuCsv(csv)
  } catch {
    return []
  }
}

export async function queryCudaVersion(): Promise<string | undefined> {
  const smi = nvidiaSmiPath()
  if (!smi) return undefined
  try {
    return parseCudaVersion(await run(smi, []))
  } catch {
    return undefined
  }
}

export interface CpuStatic {
  cpuName: string
  cpuCores: number
  cpuThreads: number
  avx2: boolean
  avx512: boolean
}

// IsProcessorFeaturePresent: PF_AVX2_INSTRUCTIONS_AVAILABLE=40, PF_AVX512F_INSTRUCTIONS_AVAILABLE=41.
const PS_CPU = [
  "$ErrorActionPreference='SilentlyContinue'",
  "$cores = (Get-CimInstance Win32_Processor | Measure-Object -Property NumberOfCores -Sum).Sum",
  "Add-Type -Namespace Nys -Name Cpu -MemberDefinition '[DllImport(\"kernel32.dll\")] public static extern bool IsProcessorFeaturePresent(uint f);'",
  '$avx2 = [Nys.Cpu]::IsProcessorFeaturePresent(40)',
  '$avx512 = [Nys.Cpu]::IsProcessorFeaturePresent(41)',
  '@{ cores = $cores; avx2 = $avx2; avx512 = $avx512 } | ConvertTo-Json -Compress'
].join('; ')

/** Разбор JSON-ответа PowerShell-скрипта. */
export function parseCpuProbe(json: string): { cores?: number; avx2?: boolean; avx512?: boolean } {
  try {
    const m = /\{.*\}/s.exec(json)
    if (!m) return {}
    const o = JSON.parse(m[0]) as { cores?: unknown; avx2?: unknown; avx512?: unknown }
    return {
      cores: typeof o.cores === 'number' && o.cores > 0 ? o.cores : undefined,
      avx2: typeof o.avx2 === 'boolean' ? o.avx2 : undefined,
      avx512: typeof o.avx512 === 'boolean' ? o.avx512 : undefined
    }
  } catch {
    return {}
  }
}

async function wmicCores(): Promise<number | undefined> {
  try {
    const out = await run('wmic', ['cpu', 'get', 'NumberOfCores', '/value'])
    const sum = [...out.matchAll(/NumberOfCores=(\d+)/g)].reduce((s, m) => s + Number(m[1]), 0)
    return sum > 0 ? sum : undefined
  } catch {
    return undefined
  }
}

async function linuxFlags(): Promise<{ avx2: boolean; avx512: boolean; cores?: number }> {
  try {
    const info = await readFile('/proc/cpuinfo', 'utf8')
    const flags = /^flags\s*:(.*)$/m.exec(info)?.[1] ?? ''
    const coreIds = new Set([...info.matchAll(/^physical id\s*:\s*(\d+)[\s\S]*?^core id\s*:\s*(\d+)/gm)].map((m) => `${m[1]}:${m[2]}`))
    return { avx2: /\bavx2\b/.test(flags), avx512: /\bavx512f\b/.test(flags), cores: coreIds.size || undefined }
  } catch {
    return { avx2: true, avx512: false }
  }
}

export async function queryCpu(): Promise<CpuStatic> {
  const cpus = os.cpus()
  const cpuThreads = os.availableParallelism?.() ?? cpus.length
  const cpuName = (cpus[0]?.model ?? 'CPU').trim()
  let cores: number | undefined
  let avx2 = true
  let avx512 = false
  if (process.platform === 'win32') {
    try {
      const probe = parseCpuProbe(await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', PS_CPU], 30000))
      cores = probe.cores
      if (probe.avx2 !== undefined) avx2 = probe.avx2
      if (probe.avx512 !== undefined) avx512 = probe.avx512
    } catch {
      // ниже — запасные варианты
    }
    cores ??= await wmicCores()
  } else {
    const l = await linuxFlags()
    avx2 = l.avx2
    avx512 = l.avx512
    cores = l.cores
  }
  return {
    cpuName,
    cpuCores: cores ?? Math.max(1, Math.round(cpuThreads / 2)),
    cpuThreads,
    avx2,
    avx512
  }
}

export function ramInfo(): { ramTotalMiB: number; ramFreeMiB: number } {
  return { ramTotalMiB: Math.round(os.totalmem() / MiB), ramFreeMiB: Math.round(os.freemem() / MiB) }
}

/** Полный опрос. cpu можно передать из кэша (он не меняется). */
export async function detectHardware(cpu?: CpuStatic, cudaVersion?: string): Promise<HardwareInfo> {
  const [gpus, cpuInfo, cuda] = await Promise.all([
    queryGpus(),
    cpu ? Promise.resolve(cpu) : queryCpu(),
    cudaVersion !== undefined ? Promise.resolve(cudaVersion) : queryCudaVersion()
  ])
  return { gpus, ...ramInfo(), ...cpuInfo, ...(gpus.length && cuda ? { cudaVersion: cuda } : {}) }
}
