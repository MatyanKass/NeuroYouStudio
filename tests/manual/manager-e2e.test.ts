// Сквозная проверка менеджера движков с настоящими модулями (реестр моделей, планировщик, сборки),
// electron подменён. Запуск: NYS_E2E=1 npx vitest run tests/manual/manager-e2e.test.ts
import { afterAll, describe, expect, it, vi } from 'vitest'
import { DEFAULT_LOAD_CONFIG, deepMerge } from '@shared/config'
import type { EngineStatus } from '@shared/types'

const h = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require('node:fs') as typeof import('node:fs')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const os = require('node:os') as typeof import('node:os')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const path = require('node:path') as typeof import('node:path')
  return {
    userData: fs.mkdtempSync(path.join(os.tmpdir(), 'nys-userdata-')),
    home: os.homedir(),
    events: [] as Array<{ channel: string; payload: unknown }>
  }
})

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => (name === 'home' ? h.home : h.userData),
    getVersion: () => '0.0.0',
    isPackaged: false
  },
  ipcMain: { handle: () => undefined },
  BrowserWindow: {
    getAllWindows: () => [
      {
        isDestroyed: () => false,
        webContents: { send: (channel: string, payload: unknown) => h.events.push({ channel, payload }) }
      }
    ]
  },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (s: string) => Buffer.from(s),
    decryptString: (b: Buffer) => b.toString()
  }
}))

const E2E = process.env.NYS_E2E === '1'

describe.skipIf(!E2E)('менеджер движков (e2e)', async () => {
  const { listModels } = await import('../../src/main/models/registry')
  const mgr = await import('../../src/main/engines/manager')
  let modelId = ''
  /** Ключ API: /health открыт, остальное — только с Bearer-ключом этого запуска. */
  const checkAuth = async (): Promise<void> => {
    const eng = mgr.activeEngine()!
    expect(eng.apiKey).toBeTruthy()
    expect((await fetch(`${eng.baseUrl}/health`)).status).toBe(200)
    const noKey = await fetch(`${eng.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }], max_tokens: 1 })
    })
    expect(noKey.status).toBe(401)
    const tok = await fetch(`${eng.baseUrl}/tokenize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${eng.apiKey}` },
      body: JSON.stringify({ content: 'hi' })
    })
    expect(tok.status).toBe(200)
    expect(mgr.engineLogs().join('\n')).not.toContain(eng.apiKey!)
    expect(mgr.engineStatus().plan?.args.join(' ')).not.toContain(eng.apiKey!)
  }
  const statuses = (): EngineStatus['state'][] =>
    h.events.filter((e) => e.channel === 'engine:status').map((e) => (e.payload as EngineStatus).state)

  afterAll(async () => {
    await mgr.shutdownEngines()
  })

  it('модель находится в папке моделей', async () => {
    const models = await listModels(true)
    const m = models.find((x) => x.path.endsWith('Qwen3-0.6B-Q8_0.gguf'))
    expect(m, 'нужна Qwen3-0.6B-Q8_0.gguf в %USERPROFILE%\\NeuroYouStudio\\models').toBeDefined()
    modelId = m!.id
  }, 60_000)

  it('предпросмотр плана с аргументами', async () => {
    const plan = await mgr.previewPlan(modelId, deepMerge(DEFAULT_LOAD_CONFIG, { contextLength: 4096 }))
    expect(plan.args).toContain('-m')
    expect(plan.args).toContain('-ngl')
    console.log('plan', plan.engine, plan.fit, plan.args.join(' '))
  }, 60_000)

  it('auto → llama.cpp, загрузка, чат, статус', async () => {
    h.events.length = 0
    const st = await mgr.loadModel(modelId, deepMerge(DEFAULT_LOAD_CONFIG, { contextLength: 4096 }))
    expect(st.state).toBe('ready')
    expect(st.engine).toBe('llamacpp')
    expect(st.actual?.kv.CUDA0).toBeGreaterThan(0)
    expect(statuses()).toEqual(expect.arrayContaining(['starting', 'loading', 'ready']))
    expect(h.events.some((e) => e.channel === 'engine:log')).toBe(true)
    const eng = mgr.activeEngine()
    expect(eng?.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    const r = await fetch(`${eng!.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${eng!.apiKey}` },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hi /no_think' }], max_tokens: 8 })
    })
    expect(r.status).toBe(200)
    expect(mgr.engineLogs().length).toBeGreaterThan(10)
    await checkAuth()
  }, 300_000)

  it('план при загруженной модели учитывает её память как свободную', async () => {
    const plan = await mgr.previewPlan(modelId, deepMerge(DEFAULT_LOAD_CONFIG, { contextLength: 4096 }))
    expect(plan.vramAvailableBytes).toBeGreaterThan(0)
  }, 60_000)

  it('защита: модель, которая не влезет, отклоняется без выгрузки текущей', async () => {
    const before = mgr.engineStatus()
    await expect(
      mgr.loadModel(modelId, deepMerge(DEFAULT_LOAD_CONFIG, { contextLength: 4_000_000 }))
    ).rejects.toThrow(/не помещается/)
    expect(mgr.engineStatus().state).toBe('ready')
    expect(mgr.engineStatus().port).toBe(before.port)
    expect(mgr.activeEngine()).not.toBeNull()
  }, 60_000)

  it('переключение на ik_llama.cpp (предыдущая выгружается)', async () => {
    const st = await mgr.loadModel(
      modelId,
      deepMerge(DEFAULT_LOAD_CONFIG, { engine: 'ikllama', contextLength: 4096, memory: { kvCache: 'ram', mode: 'manual' } })
    )
    expect(st.state).toBe('ready')
    expect(st.engine).toBe('ikllama')
    expect(st.plan?.args).toContain('-nkvo')
    expect(st.actual?.kv.CPU).toBeGreaterThan(0)
    await checkAuth()
  }, 300_000)

  it('EXL3 пока недоступен', async () => {
    await expect(
      mgr.loadModel(modelId, deepMerge(DEFAULT_LOAD_CONFIG, { engine: 'exl3' }))
    ).rejects.toThrow(/ExLlamaV3/)
  })

  it('план (planMemory) против фактических буферов', async () => {
    const MiB = 1024 * 1024
    const scenarios: Array<[string, 'llamacpp' | 'ikllama', Partial<import('@shared/config').MemoryLayout>]> = [
      ['all-gpu (auto/speed)', 'llamacpp', { mode: 'auto', profile: 'speed' }],
      ['userSplit (auto, KV в RAM)', 'llamacpp', { mode: 'auto', profile: 'userSplit' }],
      ['partial 14 (manual)', 'llamacpp', { mode: 'manual', gpuLayers: 14 }],
      ['all-gpu (auto/speed)', 'ikllama', { mode: 'auto', profile: 'speed' }],
      ['userSplit (auto, KV в RAM)', 'ikllama', { mode: 'auto', profile: 'userSplit' }],
      ['partial 14 (manual)', 'ikllama', { mode: 'manual', gpuLayers: 14 }]
    ]
    const report: Record<string, unknown> = {}
    for (const [name, engine, memory] of scenarios) {
      const st = await mgr.loadModel(modelId, deepMerge(DEFAULT_LOAD_CONFIG, { engine, contextLength: 4096, memory }))
      expect(st.state).toBe('ready')
      const plan = st.plan!
      const comp = Object.fromEntries(
        plan.components.map((c) => [c.id, { vram: +(c.vramBytes / MiB).toFixed(1), ram: +(c.ramBytes / MiB).toFixed(1) }])
      )
      report[`${engine} ${name}`] = {
        args: plan.args.filter((a) => !a.includes('\\')).join(' '),
        resolved: plan.resolved,
        planVramMiB: +(plan.vramBytes / MiB).toFixed(1),
        planRamMiB: +(plan.ramBytes / MiB).toFixed(1),
        planComponents: comp,
        actual: st.actual,
        warnings: plan.warnings
      }
    }
    const { writeFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const out = join(process.env.TEMP ?? h.userData, 'nys-plan-vs-actual.json')
    writeFileSync(out, JSON.stringify(report, null, 2))
    console.log(`plan vs actual → ${out}`)
  }, 600_000)

  it('выгрузка', async () => {
    const st = await mgr.unloadModel()
    expect(st.state).toBe('idle')
    expect(mgr.activeEngine()).toBeNull()
  }, 60_000)
})
