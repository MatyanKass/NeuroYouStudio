import { describe, expect, it } from 'vitest'
import { unifiedDiff } from '../../src/main/agent/diff'

describe('unifiedDiff', () => {
  it('пустой для одинаковых', () => {
    expect(unifiedDiff('a\nb', 'a\nb', 'f')).toBe('')
  })
  it('показывает добавленные и удалённые строки', () => {
    const d = unifiedDiff('one\ntwo\nthree', 'one\nTWO\nthree', 'f.txt')
    expect(d).toContain('--- f.txt')
    expect(d).toContain('-two')
    expect(d).toContain('+TWO')
    expect(d).toContain(' one')
  })
  it('создание файла — только добавления', () => {
    const d = unifiedDiff('', 'new\nlines', 'n.txt')
    expect(d).toContain('+new')
    expect(d).toContain('+lines')
  })
  it('усечение по maxChars', () => {
    const big = Array.from({ length: 50 }, (_, i) => `l${i}`).join('\n')
    const d = unifiedDiff('', big, 'b', 100)
    expect(d.length).toBeLessThan(160)
    expect(d).toContain('усечён')
  })
})
