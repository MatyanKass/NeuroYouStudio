// Разбор настоящих журналов llama-server (фикстуры сняты на GTX 1660, Qwen3-0.6B-Q8_0, -c 4096).
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  actualByDevice,
  classifyError,
  createLogParser,
  normalizeDevice,
  stripPrefix,
  type LogEvent
} from '../../src/main/engines/log-parser'

const fixture = (name: string): string[] =>
  readFileSync(join(__dirname, 'fixtures', `${name}.log`), 'utf8').split(/\r?\n/)

function parse(name: string): { parser: ReturnType<typeof createLogParser>; events: LogEvent[] } {
  const parser = createLogParser()
  const events = fixture(name).flatMap((l) => parser.feed(l))
  return { parser, events }
}

describe('mainline (b11538)', () => {
  it('всё на GPU', () => {
    const { parser, events } = parse('mainline-all-gpu')
    expect(parser.actual).toEqual({
      model: { CPU: 157.65, CUDA0: 604.15 },
      kv: { CUDA0: 448 },
      compute: { CUDA0: 30.01, CPU: 12.02 },
      output: { CPU: 0.58 }
    })
    expect(parser.ready).toBe(true)
    expect(parser.fatal).toBeNull()
    expect(events).toContainEqual({ type: 'offload', layers: 29, total: 29 })
    expect(events).toContainEqual({ type: 'context', nCtx: 4096 })
    const progress = events.filter((e) => e.type === 'progress').map((e) => (e as { value: number }).value)
    expect(progress.length).toBeGreaterThan(3)
    expect([...progress].sort((a, b) => a - b)).toEqual(progress)
  })

  it('KV в RAM (-nkvo) + FA: KV на CPU, веса на CUDA0', () => {
    const { parser } = parse('mainline-kv-ram-fa')
    expect(parser.actual.kv).toEqual({ CPU: 448 })
    expect(parser.actual.model.CUDA0).toBe(604.15)
  })

  it('часть слоёв (-ngl 15 = 14 блоков + голова)', () => {
    const { parser, events } = parse('mainline-partial-14')
    expect(events).toContainEqual({ type: 'offload', layers: 15, total: 29 })
    expect(parser.actual.model).toEqual({ CPU: 380.9, CUDA0: 380.9 })
    expect(parser.actual.kv).toEqual({ CPU: 224, CUDA0: 224 })
  })

  it('FFN в RAM', () => {
    const { parser } = parse('mainline-ffn-ram')
    expect(parser.actual.model.CUDA0).toBe(336.4)
  })

  it('ошибки', () => {
    expect(parse('mainline-error-oom').parser.fatal?.code).toBe('oom')
    expect(parse('mainline-error-badarg').parser.fatal).toMatchObject({ code: 'badArg', arg: '--bogus-flag' })
    expect(parse('mainline-error-nomodel').parser.fatal?.code).toBe('loadFailed')
    expect(parse('mainline-error-oom').parser.ready).toBe(false)
  })
})

describe('ik_llama.cpp (main-b5418)', () => {
  it('всё на GPU', () => {
    const { parser, events } = parse('ik-all-gpu')
    expect(parser.actual).toEqual({
      model: { CPU: 157.65, CUDA0: 604.15 },
      kv: { CUDA0: 448 },
      compute: { CUDA0: 300.75, CPU: 6.01 },
      output: { CPU: 0.58 }
    })
    expect(parser.ready).toBe(true)
    expect(events).toContainEqual({ type: 'offload', layers: 29, total: 29 })
    expect(events).toContainEqual({ type: 'context', nCtx: 4096 })
  })

  it('KV в RAM', () => {
    expect(parse('ik-kv-ram-fa').parser.actual.kv).toEqual({ CPU: 448 })
  })

  it('часть слоёв (-ngl 14 = 14 блоков, голова на CPU)', () => {
    const { parser, events } = parse('ik-partial-14')
    expect(events).toContainEqual({ type: 'offload', layers: 14, total: 29 })
    expect(parser.actual.model).toEqual({ CPU: 380.9, CUDA0: 223.25 })
  })

  it('FFN в RAM: CUDA_Host-буфер считается как RAM', () => {
    const { parser } = parse('ik-ffn-ram')
    expect(parser.actual.model).toEqual({ CPU: 425.4, CUDA0: 336.4 })
  })

  it('ошибки', () => {
    expect(parse('ik-error-oom').parser.fatal?.code).toBe('oom')
    expect(parse('ik-error-badarg').parser.fatal).toMatchObject({ code: 'badArg', arg: '--bogus-flag' })
    expect(parse('ik-error-nomodel').parser.fatal?.code).toBe('loadFailed')
  })
})

describe('вспомогательное', () => {
  it('stripPrefix', () => {
    expect(stripPrefix('0.00.660.155 I load_tensors:        CUDA0 model buffer size =   604.15 MiB')).toBe(
      'load_tensors:        CUDA0 model buffer size =   604.15 MiB'
    )
    expect(stripPrefix(' ERR [              load_model] unable to load model | tid="1"')).toBe(
      'unable to load model | tid="1"'
    )
  })

  it('normalizeDevice', () => {
    expect(normalizeDevice('CPU_Mapped')).toBe('CPU')
    expect(normalizeDevice('CUDA_Host')).toBe('CPU')
    expect(normalizeDevice('CPU_REPACK')).toBe('CPU')
    expect(normalizeDevice('Vulkan_Host')).toBe('CPU')
    expect(normalizeDevice('CUDA1')).toBe('CUDA1')
    expect(normalizeDevice('Vulkan0')).toBe('Vulkan0')
  })

  it('classifyError', () => {
    expect(classifyError('CUDA error: the provided PTX was compiled with an unsupported toolchain.')?.code).toBe('cuda')
    expect(classifyError('ggml_vulkan: ErrorOutOfDeviceMemory')?.code).toBe('oom')
    expect(classifyError('error while handling argument "-fa": invalid value')).toEqual({ code: 'badArg', arg: '-fa' })
    expect(classifyError('srv  init: couldn\'t bind HTTP server socket, hostname: 127.0.0.1, port: 8080')?.code).toBe('port')
    expect(classifyError('load_tensors: CUDA0 model buffer size = 1 MiB')).toBeNull()
  })

  it('recurrent state (RS) учитывается как KV; суммы по устройствам', () => {
    const p = createLogParser()
    p.feed('0.00.1 I llama_memory_recurrent:      CUDA0 RS buffer size =    12.50 MiB')
    p.feed('0.00.1 I llama_kv_cache:      CUDA0 KV buffer size =   100.00 MiB')
    expect(p.actual.kv).toEqual({ CUDA0: 112.5 })
    expect(actualByDevice({ model: { CUDA0: 10, CPU: 1 }, kv: { CUDA0: 5 }, compute: {}, output: { CPU: 0.5 } })).toEqual({
      CUDA0: 15,
      CPU: 1.5
    })
  })

  it('OOM важнее следующего за ним «failed to load model»', () => {
    const p = createLogParser()
    p.feed('llama_model_load: error loading model: x')
    p.feed('cudaMalloc failed: out of memory')
    expect(p.fatal?.code).toBe('oom')
  })
})
