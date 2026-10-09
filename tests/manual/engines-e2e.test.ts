// Реальный запуск llama-server (mainline и ik) с аргументами из buildLlamaServerArgs.
// Запуск: NYS_E2E=1 npx vitest run tests/manual/engines-e2e.test.ts
// Нужны установленные сборки (tests/manual/install-runtimes.test.ts) и модель Qwen3-0.6B-Q8_0.
import { mkdirSync, writeFileSync, existsSync, statSync } from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { DEFAULT_LOAD_CONFIG, DEFAULT_MEMORY_LAYOUT, deepMerge, type LoadConfig, type MemoryLayout } from '@shared/config'
import type { HardwareInfo, LocalModel } from '@shared/types'
import { detectHardware } from '../../src/main/hardware/detect'
import { RuntimeStore } from '../../src/main/runtimes/store'
import { getAdapter } from '../../src/main/engines/adapters'
import { EngineError, EngineProcess, freePort } from '../../src/main/engines/process'

const E2E = process.env.NYS_E2E === '1'
const local = join(process.env.LOCALAPPDATA ?? '', 'NeuroYouStudio')
const modelPath = join(os.homedir(), 'NeuroYouStudio', 'models', 'Qwen', 'Qwen3-0.6B-GGUF', 'Qwen3-0.6B-Q8_0.gguf')
const fixtures = join(__dirname, '..', 'engines', 'fixtures')
const summaryFile = process.env.NYS_E2E_SUMMARY ?? join(os.tmpdir(), 'nys-e2e-summary.json')

const model: LocalModel = {
  id: 'Qwen/Qwen3-0.6B-GGUF/Qwen3-0.6B-Q8_0.gguf',
  format: 'gguf',
  path: modelPath,
  files: [modelPath],
  sizeBytes: existsSync(modelPath) ? statSync(modelPath).size : 0,
  publisher: 'Qwen',
  repo: 'Qwen3-0.6B-GGUF',
  name: 'Qwen3-0.6B',
  quant: 'Q8_0',
  paramsLabel: '0.6B',
  arch: {
    arch: 'qwen3',
    nLayers: 28,
    nEmbd: 1024,
    nHead: 16,
    nHeadKv: 8,
    headDimK: 128,
    headDimV: 128,
    contextLengthMax: 40960,
    nExperts: 0,
    nExpertsUsed: 0,
    slidingWindow: 0,
    swaLayers: 0,
    mlaKvDim: 0,
    recurrentLayers: 0,
    vocabSize: 151936
  },
  isMoe: false,
  vision: false,
  isEmbedding: false
}

/** Убираем имя пользователя и путь песочницы из журналов-фикстур. */
function sanitize(text: string): string {
  const home = os.homedir()
  const variants = [home.replace(/\\/g, '\\\\'), home, home.replace(/\\/g, '/')]
  let out = text.replace(/C:[\\/]Users[\\/][^\\/]+[\\/]AppData[\\/]Local[\\/]Packages[\\/][^\\/]+[\\/]LocalCache[\\/]Local/gi, '%LOCALAPPDATA%')
  variants.forEach((v, i) => (out = out.split(v).join(i === 0 ? 'C:\\\\Users\\\\user' : 'C:\\Users\\user')))
  return out
}

interface Scenario {
  name: string
  layout: Partial<MemoryLayout>
  load?: Partial<LoadConfig>
}

const scenarios: Scenario[] = [
  { name: 'all-gpu', layout: {} },
  { name: 'kv-ram-fa', layout: { kvCache: 'ram' }, load: { flashAttention: 'on' } },
  { name: 'partial-14', layout: { gpuLayers: 14 } },
  { name: 'partial-14-head-ram', layout: { gpuLayers: 14, output: 'ram' } },
  { name: 'ffn-ram', layout: { ffn: 'ram' } },
  { name: 'attn-ram', layout: { attention: 'ram' } },
  { name: 'head-ram', layout: { output: 'ram' } }
]

async function chat(baseUrl: string): Promise<{ text: string; chunks: number; tps?: number }> {
  const res = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messages: [{ role: 'user', content: 'Назови три цвета радуги. /no_think' }],
      stream: true,
      max_tokens: 40,
      temperature: 0
    }),
    signal: AbortSignal.timeout(180_000)
  })
  expect(res.status).toBe(200)
  const body = await res.text()
  let text = ''
  let chunks = 0
  let tps: number | undefined
  for (const line of body.split('\n')) {
    if (!line.startsWith('data: ') || line.includes('[DONE]')) continue
    const j = JSON.parse(line.slice(6)) as {
      choices?: Array<{ delta?: { content?: string | null } }>
      timings?: { predicted_per_second?: number }
    }
    const c = j.choices?.[0]?.delta?.content
    if (c) {
      text += c
      chunks++
    }
    if (j.timings?.predicted_per_second) tps = j.timings.predicted_per_second
  }
  return { text, chunks, tps }
}

const summary: Record<string, unknown> = {}

describe.skipIf(!E2E)('llama-server e2e', () => {
  const store = new RuntimeStore({ runtimesDir: join(local, 'runtimes'), tmpDir: join(local, 'tmp') })
  let hw: HardwareInfo

  afterAll(() => {
    writeFileSync(summaryFile, JSON.stringify(summary, null, 2))
    console.log(`summary → ${summaryFile}`)
  })

  it('hardware', async () => {
    hw = await detectHardware()
    summary.hardware = hw
    expect(hw.cpuThreads).toBeGreaterThan(0)
  }, 60_000)

  for (const engine of ['llamacpp', 'ikllama'] as const) {
    const flavor = engine === 'llamacpp' ? 'mainline' : 'ik'
    for (const sc of scenarios) {
      it(`${flavor} ${sc.name}`, async () => {
        const rt = await store.resolve(engine, hw)
        expect(rt, `нет установленной сборки ${engine}`).not.toBeNull()
        const load = deepMerge(DEFAULT_LOAD_CONFIG, { contextLength: 4096, ...sc.load })
        const layout = { ...DEFAULT_MEMORY_LAYOUT, ...sc.layout }
        const adapter = getAdapter(engine)
        const port = await freePort()
        const spec = adapter.buildLaunch({
          model,
          load,
          layout,
          nLayers: 28,
          port,
          runtimeDir: rt!.dir,
          serverExe: rt!.serverExe,
          threadsDefault: hw.cpuCores,
          gpuDevice: rt!.entry.backend === 'cuda' ? 'CUDA0' : undefined
        })
        const parser = adapter.createLogParser()
        const events: string[] = []
        const proc = new EngineProcess({
          spec,
          port,
          parser,
          healthcheck: adapter.healthcheck,
          onEvent: (ev) => {
            if (ev.type === 'offload' || ev.type === 'ready' || ev.type === 'error') events.push(JSON.stringify(ev))
          }
        })
        const t0 = Date.now()
        proc.start()
        try {
          await proc.waitReady()
          const loadMs = Date.now() - t0
          const health = await fetch(`${proc.baseUrl}/health`)
          expect(health.status).toBe(200)
          const reply = await chat(proc.baseUrl)
          expect(reply.chunks).toBeGreaterThan(0)
          summary[`${flavor}/${sc.name}`] = {
            runtime: rt!.id,
            args: spec.args.map(sanitize),
            loadMs,
            actual: parser.actual,
            events,
            reply: reply.text.slice(0, 80),
            tokensPerSecond: reply.tps
          }
        } finally {
          await proc.stop()
          mkdirSync(fixtures, { recursive: true })
          writeFileSync(join(fixtures, `${flavor}-${sc.name}.log`), sanitize(proc.lines.join('\n')) + '\n')
        }
        expect(proc.exited).toBe(true)
      }, 600_000)
    }

    it(`${flavor} ошибка: неизвестный аргумент`, async () => {
      const rt = await store.resolve(engine, hw)
      const load = deepMerge(DEFAULT_LOAD_CONFIG, { extraArgs: { enabled: true, value: '--no-such-flag 1' } })
      const port = await freePort()
      const adapter = getAdapter(engine)
      const spec = adapter.buildLaunch({
        model, load, layout: DEFAULT_MEMORY_LAYOUT, nLayers: 28, port,
        runtimeDir: rt!.dir, serverExe: rt!.serverExe, threadsDefault: hw.cpuCores, gpuDevice: 'CUDA0'
      })
      const proc = new EngineProcess({ spec, port, parser: adapter.createLogParser(), healthcheck: adapter.healthcheck })
      proc.start()
      const err = await proc.waitReady().then(() => null, (e: unknown) => e)
      await proc.stop()
      expect(err).toBeInstanceOf(EngineError)
      expect((err as EngineError).code).toBe('badArg')
      summary[`${flavor}/error-badarg`] = (err as Error).message
    }, 120_000)

    it(`${flavor} ошибка: не хватает памяти`, async () => {
      const rt = await store.resolve(engine, hw)
      const load = deepMerge(DEFAULT_LOAD_CONFIG, { contextLength: 400_000 })
      const port = await freePort()
      const adapter = getAdapter(engine)
      const spec = adapter.buildLaunch({
        model, load, layout: DEFAULT_MEMORY_LAYOUT, nLayers: 28, port,
        runtimeDir: rt!.dir, serverExe: rt!.serverExe, threadsDefault: hw.cpuCores, gpuDevice: 'CUDA0'
      })
      const proc = new EngineProcess({ spec, port, parser: adapter.createLogParser(), healthcheck: adapter.healthcheck })
      proc.start()
      const err = await proc.waitReady().then(() => null, (e: unknown) => e)
      await proc.stop()
      writeFileSync(join(fixtures, `${flavor}-error-oom.log`), sanitize(proc.lines.join('\n')) + '\n')
      expect(err).toBeInstanceOf(EngineError)
      expect((err as EngineError).code).toBe('oom')
      summary[`${flavor}/error-oom`] = (err as Error).message
    }, 300_000)
  }
})
