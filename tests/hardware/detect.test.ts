import { describe, expect, it } from 'vitest'
import { parseCpuProbe, parseCudaVersion, parseGpuCsv, queryCpu } from '../../src/main/hardware/detect'
import { aggregateLive, parseLiveLine } from '../../src/main/hardware/live'

describe('nvidia-smi', () => {
  it('parseGpuCsv', () => {
    const csv = '0, NVIDIA GeForce GTX 1660, 6144, 3663, 591.86, 7.5\r\n1, NVIDIA GeForce RTX 5060 Ti, 16311, 15800, 591.86, 12.0\n\n'
    expect(parseGpuCsv(csv)).toEqual([
      { index: 0, name: 'NVIDIA GeForce GTX 1660', vramTotalMiB: 6144, vramFreeMiB: 3663, driverVersion: '591.86', computeCap: '7.5' },
      { index: 1, name: 'NVIDIA GeForce RTX 5060 Ti', vramTotalMiB: 16311, vramFreeMiB: 15800, driverVersion: '591.86', computeCap: '12.0' }
    ])
    expect(parseGpuCsv('NVIDIA-SMI has failed because it could not communicate with the NVIDIA driver.')).toEqual([])
  })

  it('parseCudaVersion', () => {
    expect(parseCudaVersion('| NVIDIA-SMI 591.86                 Driver Version: 591.86         CUDA Version: 13.1     |')).toBe('13.1')
    expect(parseCudaVersion('nothing')).toBeUndefined()
  })

  it('parseLiveLine / aggregateLive', () => {
    expect(parseLiveLine('2332, 6144, 32')).toEqual({ usedMiB: 2332, totalMiB: 6144, util: 32 })
    expect(parseLiveLine('[N/A], 6144, 0')).toBeNull()
    expect(parseLiveLine('')).toBeNull()
    const live = aggregateLive([
      { usedMiB: 1000, totalMiB: 6144, util: 10 },
      { usedMiB: 500, totalMiB: 16000, util: 70 }
    ])
    expect(live.vramUsedMiB).toBe(1500)
    expect(live.vramTotalMiB).toBe(22144)
    expect(live.gpuUtil).toBe(70)
    expect(live.ramTotalMiB).toBeGreaterThan(0)
    expect(aggregateLive([]).vramTotalMiB).toBe(0)
  })
})

describe('CPU', () => {
  it('parseCpuProbe', () => {
    expect(parseCpuProbe('{"cores":6,"avx2":true,"avx512":false}\r\n')).toEqual({ cores: 6, avx2: true, avx512: false })
    expect(parseCpuProbe('garbage')).toEqual({})
    expect(parseCpuProbe('{"cores":null,"avx2":true,"avx512":true}')).toEqual({ cores: undefined, avx2: true, avx512: true })
  })

  it.runIf(process.platform === 'win32')('queryCpu на этой машине', async () => {
    const cpu = await queryCpu()
    expect(cpu.cpuThreads).toBeGreaterThan(0)
    expect(cpu.cpuCores).toBeGreaterThan(0)
    expect(cpu.cpuCores).toBeLessThanOrEqual(cpu.cpuThreads)
    expect(typeof cpu.avx2).toBe('boolean')
  }, 60_000)
})
