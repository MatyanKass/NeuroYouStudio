// Раздел «Движки»: используемую сборку нельзя переустановить; закрытие без установок не ждёт.
import { describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require('node:fs') as typeof import('node:fs')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const osm = require('node:os') as typeof import('node:os')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const path = require('node:path') as typeof import('node:path')
  return { dir: fs.mkdtempSync(path.join(osm.tmpdir(), 'nys-rtm-')) }
})
vi.mock('../../src/main/ipc', () => ({ emit: () => undefined, handle: () => undefined }))
vi.mock('../../src/main/paths', () => ({ runtimesDir: () => h.dir + '/rt', tmpDownloadsDir: () => h.dir + '/tmp' }))
vi.mock('../../src/main/settings', () => ({ getSettings: () => ({ selectedRuntimes: {} }), updateSettings: async () => ({}) }))
vi.mock('../../src/main/hardware', () => ({ getHardwareInfo: async () => ({ gpus: [] }) }))

const rm = await import('../../src/main/runtimes/manager')

describe('runtimes/manager', () => {
  it('используемую сборку нельзя переустановить или удалить', async () => {
    rm.setRuntimeInUseCheck((id) => id === 'llamacpp-b11538-cpu')
    expect(() => rm.installRuntime('llamacpp-b11538-cpu')).toThrow(/используется/)
    await expect(rm.removeRuntime('llamacpp-b11538-cpu')).rejects.toThrow(/используется/)
    expect(rm.runtimeStore().isInstalling('llamacpp-b11538-cpu')).toBe(false)
  })

  it('shutdownRuntimes без установок завершается сразу', async () => {
    const t = Date.now()
    await rm.shutdownRuntimes()
    expect(Date.now() - t).toBeLessThan(1000)
  })
})
