import { describe, expect, it } from 'vitest'
import { DEFAULT_PREDICTION_CONFIG } from '@shared/config'
import { fitHistory } from './context'
import { buildSamplingParams } from './params'
import { SseParser } from './sse'
import { ThinkSplitter } from './think'

describe('SseParser', () => {
  it('собирает события из кусков', () => {
    const p = new SseParser()
    expect(p.push('data: {"a":1}\n\nda')).toEqual(['{"a":1}'])
    expect(p.push('ta: {"b":2}\r\n\r\ndata: [DONE]\n\n')).toEqual(['{"b":2}', '[DONE]'])
  })
})

describe('ThinkSplitter', () => {
  it('отделяет рассуждения, даже если тег разрезан между кусками', () => {
    const s = new ThinkSplitter('<think>', '</think>')
    const parts = ['<thi', 'nk>план', ' действий</th', 'ink>\n\nОтвет', ' готов'].map((c) => s.feed(c))
    const end = s.flush()
    const content = parts.map((p) => p.content).join('') + end.content
    const reasoning = parts.map((p) => p.reasoning).join('') + end.reasoning
    expect(reasoning).toBe('план действий')
    expect(content).toBe('Ответ готов')
  })
  it('не трогает пробелы между словами обычного ответа', () => {
    const s = new ThinkSplitter('<think>', '</think>')
    const out = ['Привет', ' мир', ', как', ' дела'].map((c) => s.feed(c).content).join('') + s.flush().content
    expect(out).toBe('Привет мир, как дела')
  })
})

describe('ThinkSplitter: шаблон открыл <think> сам и продолжение', () => {
  const run = (s: ThinkSplitter, parts: string[]): { content: string; reasoning: string; reclassified: boolean } => {
    let content = ''
    let reasoning = ''
    let reclassified = false
    for (const p of [...parts.map((x) => s.feed(x)), s.flush()]) {
      if (p.reclassify) {
        // как в generate: уже выданный «ответ» — это рассуждение
        reasoning += content
        content = ''
        reclassified = true
      }
      content += p.content
      reasoning += p.reasoning
    }
    return { content, reasoning, reclassified }
  }
  it('«голый» </think> (в том числе разрезанный) переносит выданное в рассуждения', () => {
    const r = run(new ThinkSplitter('<think>', '</think>'), ['Посчитаю', ' 2+2.</', 'think>\n\n', 'Ответ: 4'])
    expect(r).toEqual({ content: 'Ответ: 4', reasoning: 'Посчитаю 2+2.', reclassified: true })
  })
  it('тег в `коде` ответа не считается концом рассуждения', () => {
    const r = run(new ThinkSplitter('<think>', '</think>'), ['Тег `</think>` закрывает блок'])
    expect(r).toEqual({ content: 'Тег `</think>` закрывает блок', reasoning: '', reclassified: false })
  })
  it('после обычного <think>…</think> второй </think> — просто текст', () => {
    const r = run(new ThinkSplitter('<think>', '</think>'), ['<think>a</think>Ответ', ' и </think>'])
    expect(r).toEqual({ content: 'Ответ и </think>', reasoning: 'a', reclassified: false })
  })
  it('продолжение ответа сохраняет ведущий пробел', () => {
    const r = run(new ThinkSplitter('<think>', '</think>', { afterContent: true }), [' мир'])
    expect(r.content).toBe(' мир')
  })
  it('продолжение у ik_llama: пустой <think></think> перед дописанным текстом не добавляет переводов строк', () => {
    const r = run(new ThinkSplitter('<think>', '</think>', { afterContent: true }), ['<think>\n\n</th', 'ink>\n', '\n желтый'])
    expect(r.content).toBe(' желтый')
    expect(r.reasoning.trim()).toBe('')
  })
  it('startsInThink: всё до </think> — рассуждение', () => {
    const r = run(new ThinkSplitter('<think>', '</think>', { startsInThink: true }), ['план', '</think>', ' ответ'])
    expect(r).toEqual({ content: 'ответ', reasoning: 'план', reclassified: false })
  })
})

describe('fitHistory', () => {
  const msgs = [
    { role: 'user' as const, tokens: 100 },
    { role: 'assistant' as const, tokens: 100 },
    { role: 'user' as const, tokens: 100 },
    { role: 'assistant' as const, tokens: 100 },
    { role: 'user' as const, tokens: 100 }
  ]
  it('ничего не трогает, если всё влезает', () => {
    expect(fitHistory(msgs, 0, 1000, 'truncateMiddle').keep).toEqual([0, 1, 2, 3, 4])
  })
  it('скользящее окно выбрасывает самые старые пары', () => {
    expect(fitHistory(msgs, 0, 300, 'rollingWindow').keep).toEqual([2, 3, 4])
  })
  it('обрезка середины сохраняет первое сообщение', () => {
    expect(fitHistory(msgs, 0, 300, 'truncateMiddle').keep).toEqual([0, 1, 4])
  })
  it('роли продолжают чередоваться', () => {
    const keep = fitHistory(msgs, 0, 200, 'truncateMiddle').keep
    const roles = keep.map((i) => msgs[i]!.role)
    expect(roles[0]).toBe('user')
    for (let i = 1; i < roles.length; i++) expect(roles[i]).not.toBe(roles[i - 1])
  })
  it('stopAtLimit бросает ошибку', () => {
    expect(() => fitHistory(msgs, 0, 300, 'stopAtLimit')).toThrow(/не помещается/)
  })
})

describe('buildSamplingParams', () => {
  it('llama-server: выключенные параметры получают нейтральные значения', () => {
    const p = {
      ...DEFAULT_PREDICTION_CONFIG,
      topP: { enabled: false, value: 0.5 },
      repeatPenalty: { enabled: false, value: 1.3 }
    }
    const r = buildSamplingParams(p, 'llamacpp')
    expect(r.top_p).toBe(1)
    expect(r.repeat_penalty).toBe(1)
    expect(r.min_p).toBe(0.05)
    expect(r.max_tokens).toBeUndefined()
  })
  it('TabbyAPI использует свои имена полей', () => {
    const r = buildSamplingParams(DEFAULT_PREDICTION_CONFIG, 'exl3')
    expect(r.repetition_penalty).toBe(1.1)
    expect(r.repeat_penalty).toBeUndefined()
  })
  it('ошибка в JSON-схеме даёт понятное сообщение', () => {
    const p = { ...DEFAULT_PREDICTION_CONFIG, structured: { type: 'json' as const, jsonSchema: '{oops', gbnf: '' } }
    expect(() => buildSamplingParams(p, 'llamacpp')).toThrow(/JSON-схема/)
  })
})
