import { describe, expect, it } from 'vitest'
import type { HardwareInfo } from '@shared/types'
import {
  RUNTIME_CATALOG,
  ccToInt,
  driverCudaVersion,
  evaluateRuntime,
  recommendedRuntimeIds
} from '../../src/main/runtimes/catalog'

const gpu = (computeCap: string, driverVersion: string, name = 'GPU') => ({
  index: 0,
  name,
  vramTotalMiB: 16384,
  vramFreeMiB: 15000,
  driverVersion,
  computeCap
})

const hw = (over: Partial<HardwareInfo>): HardwareInfo => ({
  gpus: [],
  ramTotalMiB: 32768,
  ramFreeMiB: 20000,
  cpuName: 'CPU',
  cpuCores: 8,
  cpuThreads: 16,
  avx2: true,
  avx512: false,
  ...over
})

const ev = (id: string, h: HardwareInfo) => evaluateRuntime(RUNTIME_CATALOG.find((e) => e.id === id)!, h, 'win32')
const rec = (h: HardwareInfo) => [...recommendedRuntimeIds(h, RUNTIME_CATALOG, 'win32')].sort()

describe('каталог', () => {
  it('целостность', () => {
    const ids = new Set<string>()
    for (const e of RUNTIME_CATALOG) {
      expect(ids.has(e.id)).toBe(false)
      ids.add(e.id)
      expect(e.files.length).toBeGreaterThan(0)
      for (const f of e.files) {
        expect(f.sha256).toMatch(/^[0-9a-f]{64}$/)
        expect(f.url).toMatch(/^https:\/\/github\.com\/(ggml-org\/llama\.cpp|Thireus\/ik_llama\.cpp)\/releases\/download\//)
        expect(f.url.endsWith(`/${f.name}`)).toBe(true)
        expect(f.size).toBeGreaterThan(1_000_000)
      }
      if (e.backend === 'cuda') expect(e.cuda).toBeDefined()
      // Правило интерфейса: без разделителя «·».
      for (const text of [e.title, e.variant, e.description]) expect(text).not.toContain('·')
    }
  })

  it('ccToInt / driverCudaVersion', () => {
    expect(ccToInt('7.5')).toBe(75)
    expect(ccToInt('12.0')).toBe(120)
    expect(driverCudaVersion('591.86')).toBe('13.1')
    expect(driverCudaVersion('580.97')).toBe('13.0')
    expect(driverCudaVersion('552.22')).toBe('12.4')
    expect(driverCudaVersion('531.00')).toBe('12.1')
  })
})

describe('совместимость и рекомендации', () => {
  it('машина разработчика: GTX 1660 (sm_75), драйвер 591.86 (CUDA 13.1), Ryzen без AVX-512', () => {
    const h = hw({ gpus: [gpu('7.5', '591.86', 'GTX 1660')], cudaVersion: '13.1' })
    expect(ev('llamacpp-b11538-cuda12.4', h)).toMatchObject({ compatible: true, jit: true })
    // 13.4: для sm_75 только PTX, а драйвер знает лишь CUDA 13.1.
    expect(ev('llamacpp-b11538-cuda13.4', h).compatible).toBe(false)
    expect(ev('llamacpp-b11538-cuda13.4', h).reason).toMatch(/CUDA 13\.1/)
    expect(ev('ikllama-b5418-cuda12.8-avx2', h).compatible).toBe(true)
    expect(ev('ikllama-b5418-cuda12.8-avx512', h).reason).toMatch(/AVX-512/)
    expect(ev('ikllama-b5418-cuda13.3-avx2', h).compatible).toBe(false)
    expect(rec(h)).toEqual(['ikllama-b5418-cuda12.8-avx2', 'llamacpp-b11538-cuda12.4'])
  })

  it('пользователь: RTX 5060 Ti (sm_120), свежий драйвер', () => {
    const h = hw({ gpus: [gpu('12.0', '596.36', 'RTX 5060 Ti')], cudaVersion: '13.2' })
    expect(ev('llamacpp-b11538-cuda13.4', h)).toMatchObject({ compatible: true })
    expect(ev('llamacpp-b11538-cuda13.4', h).jit).toBeUndefined()
    // 12.4 тоже запустится (JIT из PTX 9.0), но не рекомендуется.
    expect(ev('llamacpp-b11538-cuda12.4', h)).toMatchObject({ compatible: true, jit: true })
    expect(rec(h)).toEqual(['ikllama-b5418-cuda13.3-avx2', 'llamacpp-b11538-cuda13.4'])
    expect(rec({ ...h, avx512: true })).toEqual(['ikllama-b5418-cuda13.3-avx512', 'llamacpp-b11538-cuda13.4'])
  })

  it('Blackwell со старым драйвером R575 → сборки CUDA 12', () => {
    const h = hw({ gpus: [gpu('12.0', '576.02')], cudaVersion: '12.9' })
    expect(ev('llamacpp-b11538-cuda13.4', h).reason).toMatch(/580/)
    expect(rec(h)).toEqual(['ikllama-b5418-cuda12.8-avx2', 'llamacpp-b11538-cuda12.4'])
  })

  it('RTX 4090 (sm_89) → CUDA 12 c готовым кодом', () => {
    const h = hw({ gpus: [gpu('8.9', '591.86')], cudaVersion: '13.1' })
    expect(ev('llamacpp-b11538-cuda12.4', h).jit).toBeUndefined()
    expect(rec(h)).toEqual(['ikllama-b5418-cuda12.8-avx2', 'llamacpp-b11538-cuda12.4'])
  })

  it('старый драйвер 546 на Turing: 12.4 нельзя (нужен JIT CUDA 12.4)', () => {
    const h = hw({ gpus: [gpu('7.5', '546.33')], cudaVersion: '12.3' })
    expect(ev('llamacpp-b11538-cuda12.4', h).compatible).toBe(false)
    expect(rec(h)).toEqual(['ikllama-b5418-cpu-avx2', 'llamacpp-b11538-vulkan'])
  })

  it('без NVIDIA → CPU', () => {
    const h = hw({ gpus: [] })
    expect(ev('llamacpp-b11538-cuda12.4', h).reason).toMatch(/NVIDIA/)
    expect(rec(h)).toEqual(['ikllama-b5418-cpu-avx2', 'llamacpp-b11538-cpu'])
  })

  it('не Windows → несовместимо', () => {
    const e = RUNTIME_CATALOG[0]!
    expect(evaluateRuntime(e, hw({}), 'linux').compatible).toBe(false)
  })
})
