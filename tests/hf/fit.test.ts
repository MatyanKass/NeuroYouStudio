import { describe, expect, it } from 'vitest'
import type { HardwareInfo } from '@shared/types'
import { estimateFit, estimateNeededBytes, hardwareKnown } from '../../src/main/hf/fit'

const GiB = 1024 ** 3
const MiB = 1024 ** 2

function hw(vramMiB: number[], ramMiB: number): HardwareInfo {
  return {
    gpus: vramMiB.map((v, index) => ({
      index,
      name: 'GPU',
      vramTotalMiB: v,
      vramFreeMiB: v,
      driverVersion: '',
      computeCap: '8.9'
    })),
    ramTotalMiB: ramMiB,
    ramFreeMiB: ramMiB,
    cpuName: '',
    cpuCores: 8,
    cpuThreads: 16,
    avx2: true,
    avx512: false
  }
}

describe('estimateFit', () => {
  it('формула: веса×1.05 + max(6%, 512 МиБ) + 400 МиБ', () => {
    expect(estimateNeededBytes(1 * GiB)).toBe(1.05 * GiB + 512 * MiB + 400 * MiB)
    expect(estimateNeededBytes(20 * GiB)).toBeCloseTo(20 * GiB * 1.11 + 400 * MiB, -3)
  })

  it('full: влезает в VRAM за вычетом резерва', () => {
    const r = estimateFit(5 * GiB, 'gguf', hw([12288], 32768))
    expect(r.fit).toBe('full')
    expect(r.note).toMatch(/Полностью в VRAM/)
  })

  it('partial только для GGUF; для EXL3 — none', () => {
    const big = 16 * GiB
    expect(estimateFit(big, 'gguf', hw([12288], 32768)).fit).toBe('partial')
    expect(estimateFit(big, 'gguf', hw([12288], 32768)).note).toMatch(/Частично в RAM/)
    const e = estimateFit(big, 'exl3', hw([12288], 32768))
    expect(e.fit).toBe('none')
    expect(e.note).toMatch(/ExLlamaV3/)
  })

  it('граница full: VRAM − 768 МиБ', () => {
    const vram = 12288
    const avail = (vram - 768) * MiB
    // подбираем размер весов так, чтобы потребность была чуть меньше/больше доступного
    const sizeFor = (need: number): number => (need - 400 * MiB) / 1.11
    expect(estimateFit(sizeFor(avail) - 1024, 'gguf', hw([vram], 0)).fit).toBe('full')
    expect(estimateFit(sizeFor(avail) + 1024 * 1024, 'exl3', hw([vram], 0)).fit).toBe('none')
  })

  it('несколько GPU суммируются', () => {
    expect(estimateFit(18 * GiB, 'exl3', hw([12288, 12288], 16384)).fit).toBe('full')
  })

  it('без GPU: ram, если влезает в 80% RAM', () => {
    expect(estimateFit(4 * GiB, 'gguf', hw([], 16384)).fit).toBe('ram')
    expect(estimateFit(20 * GiB, 'gguf', hw([], 16384)).fit).toBe('none')
    expect(estimateFit(1 * GiB, 'exl3', hw([], 16384)).fit).toBe('none')
  })

  it('none: не влезает даже в VRAM+RAM', () => {
    const r = estimateFit(200 * GiB, 'gguf', hw([12288], 32768))
    expect(r.fit).toBe('none')
    expect(r.note).toMatch(/Слишком большая/)
  })

  it('hardwareKnown', () => {
    expect(hardwareKnown(hw([], 0))).toBe(false)
    expect(hardwareKnown(null)).toBe(false)
    expect(hardwareKnown(hw([], 1024))).toBe(true)
  })
})
