import type { EngineId, PredictionConfig } from '@shared/config'

// Перевод настроек генерации (как в LM Studio) в поля запроса конкретного движка.

function parseLogitBias(raw: string): Array<[number, number | false]> {
  if (!raw.trim()) return []
  try {
    const arr = JSON.parse(raw) as unknown
    if (!Array.isArray(arr)) return []
    const out: Array<[number, number | false]> = []
    for (const item of arr) {
      if (!Array.isArray(item) || typeof item[0] !== 'number') continue
      const v = item[1]
      if (v === '-inf' || v === false) out.push([item[0], false])
      else if (typeof v === 'number') out.push([item[0], v])
    }
    return out
  } catch {
    return []
  }
}

function jsonSchemaOf(p: PredictionConfig): unknown {
  if (p.structured.type !== 'json') return undefined
  try {
    return p.structured.jsonSchema.trim() ? JSON.parse(p.structured.jsonSchema) : {}
  } catch {
    throw new Error('Структурированный вывод: JSON-схема содержит ошибку')
  }
}

export function buildSamplingParams(p: PredictionConfig, engine: EngineId): Record<string, unknown> {
  const topK = p.topK > 0 ? p.topK : 0
  const topP = p.topP.enabled ? p.topP.value : 1
  const minP = p.minP.enabled ? p.minP.value : 0
  const repeat = p.repeatPenalty.enabled ? p.repeatPenalty.value : 1
  const presence = p.presencePenalty.enabled ? p.presencePenalty.value : 0
  const frequency = p.frequencyPenalty.enabled ? p.frequencyPenalty.value : 0
  const xtcP = p.xtcProbability.enabled ? p.xtcProbability.value : 0
  const xtcT = p.xtcThreshold.enabled ? p.xtcThreshold.value : 0.1
  const typical = p.typicalP.enabled ? p.typicalP.value : 1
  const schema = jsonSchemaOf(p)
  const bias = parseLogitBias(p.logitBias)
  const stop = p.stopStrings.filter((s) => s.length > 0)

  const common: Record<string, unknown> = {
    temperature: p.temperature,
    top_k: topK,
    top_p: topP,
    min_p: minP,
    presence_penalty: presence,
    frequency_penalty: frequency,
    xtc_probability: xtcP,
    xtc_threshold: xtcT
  }
  if (p.maxTokens.enabled) common.max_tokens = p.maxTokens.value
  if (stop.length) common.stop = stop
  if (p.seed.enabled) common.seed = p.seed.value

  if (engine === 'exl3') {
    // TabbyAPI
    const out: Record<string, unknown> = {
      ...common,
      repetition_penalty: repeat,
      typical,
      mirostat_mode: p.mirostat.version,
      mirostat_tau: p.mirostat.targetEntropy,
      mirostat_eta: p.mirostat.learningRate,
      template_vars: { enable_thinking: p.reasoning.enableThinking }
    }
    if (schema !== undefined) out.json_schema = schema
    if (p.structured.type === 'gbnf' && p.structured.gbnf.trim()) out.grammar_string = p.structured.gbnf
    if (bias.length) out.logit_bias = Object.fromEntries(bias.map(([t, v]) => [String(t), v === false ? -100 : v]))
    return out
  }

  // llama.cpp / ik_llama.cpp (llama-server)
  const out: Record<string, unknown> = {
    ...common,
    repeat_penalty: repeat,
    typical_p: typical,
    mirostat: p.mirostat.version,
    mirostat_tau: p.mirostat.targetEntropy,
    mirostat_eta: p.mirostat.learningRate,
    chat_template_kwargs: { enable_thinking: p.reasoning.enableThinking }
  }
  if (schema !== undefined) out.response_format = { type: 'json_schema', json_schema: { schema } }
  if (p.structured.type === 'gbnf' && p.structured.gbnf.trim()) out.grammar = p.structured.gbnf
  if (bias.length) out.logit_bias = bias
  return out
}
