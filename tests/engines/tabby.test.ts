import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { parse } from 'yaml'
import { describe, expect, it } from 'vitest'
import { DEFAULT_LOAD_CONFIG, type LoadConfig } from '@shared/config'
import type { LocalModel } from '@shared/types'
import {
  buildTabbyConfig,
  createTabbyLogParser,
  tabbyAdapter,
  tabbyApiTokens,
  tabbyCacheMode
} from '../../src/main/engines/tabby'

const model: LocalModel = {
  id: 'turboderp/Qwen3-8B-exl3__4.0bpw',
  format: 'exl3',
  path: 'C:\\models\\turboderp\\Qwen3-8B-exl3__4.0bpw',
  files: [],
  sizeBytes: 5e9,
  publisher: 'turboderp',
  repo: 'Qwen3-8B-exl3__4.0bpw',
  name: 'Qwen3-8B',
  quant: '4.0bpw',
  paramsLabel: '8B',
  isMoe: false,
  vision: false,
  isEmbedding: false
}

const load = (patch: Partial<LoadConfig> = {}): LoadConfig => ({ ...DEFAULT_LOAD_CONFIG, ...patch })

describe('tabbyCacheMode', () => {
  it('FP16 без квантования', () => {
    expect(tabbyCacheMode(load())).toBe('FP16')
  })
  it('k,v биты из типов llama.cpp', () => {
    expect(
      tabbyCacheMode(load({ kCacheType: { enabled: true, value: 'q8_0' }, vCacheType: { enabled: true, value: 'q4_0' } }))
    ).toBe('8,4')
  })
  it('квантована одна половина — вторая в 8 битах', () => {
    expect(tabbyCacheMode(load({ kCacheType: { enabled: true, value: 'q4_0' } }))).toBe('4,8')
  })
})

describe('buildTabbyConfig', () => {
  it('модель, порт, контекст кратный 256, без авторизации', () => {
    const cfg = buildTabbyConfig({
      model,
      load: load({ contextLength: 10000 }),
      layout: DEFAULT_LOAD_CONFIG.memory,
      nLayers: 36,
      port: 5123
    }) as { network: Record<string, unknown>; model: Record<string, unknown> }
    expect(cfg.network.port).toBe(5123)
    expect(cfg.network.disable_auth).toBe(true)
    expect(cfg.network.host).toBe('127.0.0.1')
    expect(cfg.model.model_name).toBe('Qwen3-8B-exl3__4.0bpw')
    expect(cfg.model.model_dir).toBe('C:\\models\\turboderp')
    expect(cfg.model.max_seq_len).toBe(10000)
    expect(cfg.model.cache_size).toBe(10240)
    expect(cfg.model.cpu_moe_offload_layers).toBeUndefined()
  })
  it('MoE: эксперты в RAM и vision в RAM', () => {
    const cfg = buildTabbyConfig({
      model: { ...model, isMoe: true, vision: true },
      load: load(),
      layout: { ...DEFAULT_LOAD_CONFIG.memory, expertsCpuLayers: -1, mmproj: 'ram' },
      nLayers: 48,
      port: 1
    }) as { model: Record<string, unknown> }
    expect(cfg.model.cpu_moe_offload_layers).toBe(48)
    expect(cfg.model.vision_offload).toBe(true)
  })
})

describe('createTabbyLogParser', () => {
  it('готовность и OOM', () => {
    const p = createTabbyLogParser()
    p.feed('INFO:     Uvicorn running on http://127.0.0.1:5123')
    expect(p.ready).toBe(true)
    const q = createTabbyLogParser()
    q.feed('Traceback (most recent call last):')
    q.feed('torch.OutOfMemoryError: CUDA out of memory. Tried to allocate 2.00 GiB')
    expect(q.fatal?.code).toBe('oom')
  })
})

describe('TabbyAPI: ключ API', () => {
  it('с ключом авторизация включена, CORS закрыт', () => {
    const cfg = buildTabbyConfig({
      model,
      load: load(),
      layout: DEFAULT_LOAD_CONFIG.memory,
      nLayers: 36,
      port: 5123,
      apiKey: 'k3y'
    }) as { network: Record<string, unknown> }
    expect(cfg.network.disable_auth).toBe(false)
    expect(cfg.network.allowed_origins).toEqual([])
  })

  it('api_tokens.yml: один ключ как обычный и админский', () => {
    expect(parse(tabbyApiTokens('k3y'))).toEqual({ api_key: 'k3y', admin_key: 'k3y' })
  })

  const launch = (runtimeDir: string, extra: { preview?: boolean; apiKey?: string }) =>
    tabbyAdapter.buildLaunch({
      model,
      load: load(),
      layout: DEFAULT_LOAD_CONFIG.memory,
      nLayers: 36,
      port: 5123,
      runtimeDir,
      serverExe: 'python.exe',
      threadsDefault: 6,
      gpuDevice: 'CUDA0',
      ...extra
    })

  it('запуск пишет config.yml и api_tokens.yml с ключом; предпросмотр ничего не пишет', () => {
    const dir = mkdtempSync(join(os.tmpdir(), 'nys-tabby-'))
    const tabbyDir = join(dir, 'tabbyAPI')
    mkdirSync(tabbyDir)
    launch(dir, { preview: true, apiKey: 'k3y' })
    expect(existsSync(join(tabbyDir, 'config.yml'))).toBe(false)
    expect(existsSync(join(tabbyDir, 'api_tokens.yml'))).toBe(false)

    const spec = launch(dir, { apiKey: 'k3y' })
    const cfg = parse(readFileSync(join(tabbyDir, 'config.yml'), 'utf8')) as { network: Record<string, unknown> }
    expect(cfg.network.disable_auth).toBe(false)
    expect(parse(readFileSync(join(tabbyDir, 'api_tokens.yml'), 'utf8'))).toEqual({ api_key: 'k3y', admin_key: 'k3y' })
    expect(spec.secrets).toEqual(['k3y'])
    expect(spec.displayArgs?.join(' ')).not.toContain('k3y')
  })
})
