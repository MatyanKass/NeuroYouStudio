import { describe, expect, it } from 'vitest'
import { parseTextToolCalls } from '../../src/main/agent/parse-text-tools'

describe('parseTextToolCalls', () => {
  it('вызов в ```json блоке: распознаёт и очищает текст', () => {
    const text = 'Давайте создадим файл.\n```json\n{"name": "write_file", "arguments": {"path": "plan.md", "content": "# План"}}\n```\nГотово.'
    const r = parseTextToolCalls(text)
    expect(r.calls).toHaveLength(1)
    expect(r.calls[0]!.name).toBe('write_file')
    expect(JSON.parse(r.calls[0]!.arguments)).toEqual({ path: 'plan.md', content: '# План' })
    expect(r.cleaned).not.toContain('{')
    expect(r.cleaned).toContain('Давайте создадим файл')
    expect(r.cleaned).toContain('Готово')
  })

  it('голый JSON без ограждения', () => {
    const r = parseTextToolCalls('{"name":"run_command","arguments":{"command":"python hello.py"}}')
    expect(r.calls).toHaveLength(1)
    expect(r.calls[0]!.name).toBe('run_command')
  })

  it('формат OpenAI с function и строковыми аргументами', () => {
    const r = parseTextToolCalls('{"function": {"name": "read_file", "arguments": "{\\"path\\": \\"a.txt\\"}"}}')
    expect(r.calls).toHaveLength(1)
    expect(JSON.parse(r.calls[0]!.arguments)).toEqual({ path: 'a.txt' })
  })

  it('tool_calls массив и tool/parameters', () => {
    expect(parseTextToolCalls('{"tool_calls":[{"name":"list_dir","arguments":{"path":"."}}]}').calls).toHaveLength(1)
    expect(parseTextToolCalls('{"tool":"edit_file","parameters":{"path":"x"}}').calls[0]!.name).toBe('edit_file')
  })

  it('несколько вызовов подряд', () => {
    const r = parseTextToolCalls('{"name":"write_file","arguments":{"path":"a"}} затем {"name":"run_command","arguments":{"command":"ls"}}')
    expect(r.calls.map((c) => c.name)).toEqual(['write_file', 'run_command'])
  })

  it('обычный JSON-текст и данные не считаются вызовом', () => {
    expect(parseTextToolCalls('{"user":"vasya","age":30}').calls).toHaveLength(0)
    expect(parseTextToolCalls('Вот пример: `{"ключ": "значение"}` — это данные.').calls).toHaveLength(0)
    expect(parseTextToolCalls('просто текст без json').calls).toHaveLength(0)
  })

  it('неизвестный инструмент игнорируется', () => {
    expect(parseTextToolCalls('{"name":"delete_everything","arguments":{}}').calls).toHaveLength(0)
  })

  it('незакрытый/битый JSON не падает', () => {
    expect(parseTextToolCalls('{"name":"write_file","arguments":{"path":"a"').calls).toHaveLength(0)
  })
})
