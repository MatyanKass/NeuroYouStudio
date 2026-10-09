// Адаптеры движков. llama.cpp и ik_llama.cpp — один llama-server с разными флагами;
// ExLlamaV3 (TabbyAPI) подключится сюда же отдельным адаптером.
import type { EngineId } from '@shared/config'
import { buildLlamaServerArgs, type LlamaFlavor } from './llamacpp-args'
import { createLogParser } from './log-parser'
import type { EngineAdapter, HealthState, LaunchInput, LaunchSpec } from './types'

export const EXL3_NOT_READY = 'Движок ExLlamaV3 появится в следующей версии'

export const ENGINE_TITLES: Record<EngineId, string> = {
  llamacpp: 'llama.cpp',
  ikllama: 'ik_llama.cpp',
  exl3: 'ExLlamaV3'
}

const MAINLINE_KV = ['f32', 'f16', 'bf16', 'q8_0', 'q5_1', 'q5_0', 'q4_1', 'q4_0', 'iq4_nl']

/** Окружение для движка: без чужих LLAMA_ARG_* и с большим кэшем JIT CUDA. */
export function engineEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(base)) if (!k.startsWith('LLAMA_ARG_')) env[k] = v
  // PTX → SASS для старых/новых GPU компилируется при первом запуске; кэш по умолчанию мал.
  env.CUDA_CACHE_MAXSIZE ??= '4294967296'
  return env
}

export async function llamaHealth(baseUrl: string, signal?: AbortSignal): Promise<HealthState> {
  const t = AbortSignal.timeout(3000)
  try {
    const res = await fetch(`${baseUrl}/health`, { signal: signal ? AbortSignal.any([signal, t]) : t })
    await res.body?.cancel().catch(() => undefined)
    if (res.status === 200) return 'ready'
    if (res.status === 503) return 'loading'
    return 'down'
  } catch {
    return 'down'
  }
}

function llamaAdapter(id: 'llamacpp' | 'ikllama', flavor: LlamaFlavor): EngineAdapter {
  return {
    id,
    title: ENGINE_TITLES[id],
    capabilities: {
      gpuLayers: true,
      kvOffloadToggle: true,
      tensorOverrides: true,
      moeCpu: true,
      speculative: true,
      vision: true,
      kvCacheTypes: flavor === 'ik' ? [...MAINLINE_KV, 'q6_0', 'q8_KV'] : MAINLINE_KV
    },
    buildLaunch(input: LaunchInput): LaunchSpec {
      const args = buildLlamaServerArgs({
        flavor,
        model: input.model,
        load: input.load,
        layout: input.layout,
        nLayers: input.nLayers,
        port: input.port,
        threadsDefault: input.threadsDefault,
        gpuDevice: input.gpuDevice,
        draftModelPath: input.draftModelPath,
        templateFile: input.templateFile
      })
      return { exe: input.serverExe, args, env: engineEnv(), cwd: input.runtimeDir }
    },
    createLogParser,
    parseLogLine: (line) => createLogParser().feed(line),
    healthcheck: llamaHealth
  }
}

export const llamacppAdapter = llamaAdapter('llamacpp', 'mainline')
export const ikllamaAdapter = llamaAdapter('ikllama', 'ik')

export function getAdapter(engine: EngineId): EngineAdapter {
  if (engine === 'llamacpp') return llamacppAdapter
  if (engine === 'ikllama') return ikllamaAdapter
  throw new Error(EXL3_NOT_READY)
}
