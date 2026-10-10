import { describe, expect, it } from 'vitest'
import type { AgentTurn, ToolCallRecord } from '@shared/types'
import {
  appendToLastTurn,
  awaitingCalls,
  commandShell,
  diffLineKind,
  diffStat,
  formatDuration,
  mergeTurns,
  relativeTo,
  toolSubject,
  toolVerb,
  truncateMiddle
} from './agent'

const tc = (name: string, args: Record<string, unknown>, extra: Partial<ToolCallRecord> = {}): ToolCallRecord => ({
  id: Math.random().toString(36).slice(2),
  name,
  args,
  status: 'done',
  ...extra
})

describe('подписи инструментов', () => {
  it('глагол и оболочка команды', () => {
    expect(toolVerb(tc('read_file', { path: 'a.txt' }))).toBe('Прочитан файл')
    expect(toolVerb(tc('run_command', { command: 'dir', shell: 'cmd' }))).toBe('Команда (cmd)')
    expect(toolVerb(tc('run_command', { command: 'ls' }), 'powershell')).toBe('Команда (PowerShell)')
    expect(commandShell(tc('run_command', { shell: 'pwsh' }), 'cmd')).toBe('powershell')
  })

  it('главный аргумент', () => {
    expect(toolSubject(tc('write_file', { path: 'src/a.ts', content: 'x' }))).toBe('src/a.ts')
    expect(toolSubject(tc('run_command', { command: 'npm test' }))).toBe('npm test')
    expect(toolSubject(tc('search_files', { query: 'TODO', path: 'src' }))).toBe('«TODO» в src')
    expect(toolSubject(tc('list_dir', {}))).toBe('.')
  })
})

describe('пути и усечение', () => {
  it('усечение из середины сохраняет длину', () => {
    const s = 'D:\\Projects\\NeuroYouStudio\\src\\renderer\\src\\components\\chat\\AgentSteps.tsx'
    const t = truncateMiddle(s, 40)
    expect(t).toHaveLength(40)
    expect(t).toContain('…')
    expect(t.endsWith('AgentSteps.tsx')).toBe(true)
    expect(truncateMiddle('short', 40)).toBe('short')
  })

  it('путь относительно рабочей папки', () => {
    expect(relativeTo('D:\\Work\\proj\\src\\a.ts', 'D:\\Work\\proj')).toBe('src\\a.ts')
    expect(relativeTo('d:\\work\\proj\\b.ts', 'D:\\Work\\proj\\')).toBe('b.ts')
    expect(relativeTo('D:\\Work\\project2\\a.ts', 'D:\\Work\\proj')).toBe('D:\\Work\\project2\\a.ts')
    expect(relativeTo('src/a.ts', undefined)).toBe('src/a.ts')
  })

  it('длительность', () => {
    expect(formatDuration(380)).toBe('0,4 с')
    expect(formatDuration(12_400)).toBe('12 с')
    expect(formatDuration(75_000)).toBe('1 мин 15 с')
  })
})

describe('diff', () => {
  it('классы строк и счётчик', () => {
    const d = '--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@\n ctx\n-old\n+new\n+more'
    expect(diffLineKind('+++ b/x')).toBe('meta')
    expect(diffLineKind('@@ -1 +1 @@')).toBe('hunk')
    expect(diffLineKind('-old')).toBe('del')
    expect(diffStat(d)).toEqual({ added: 2, removed: 1 })
  })
})

describe('снимки шагов', () => {
  const turn = (content: string, calls: ToolCallRecord[] = []): AgentTurn => ({ content, toolCalls: calls })

  it('снимок не откатывает уже пришедший потоком текст', () => {
    const local = [turn('Сначала прочитаю файл и потом')]
    const snap = [turn('Сначала прочитаю', [tc('read_file', { path: 'a' }, { status: 'running' })])]
    const merged = mergeTurns(local, snap)
    expect(merged[0]!.content).toBe('Сначала прочитаю файл и потом')
    expect(merged[0]!.toolCalls[0]!.status).toBe('running')
  })

  it('снимок с другим текстом побеждает', () => {
    expect(mergeTurns([turn('abc')], [turn('xyz')])[0]!.content).toBe('xyz')
  })

  it('дельта дописывается в последний шаг', () => {
    const t = appendToLastTurn([turn('a'), turn('b')], 'c', 'r')
    expect(t[1]!.content).toBe('bc')
    expect(t[1]!.reasoning).toBe('r')
    expect(t[0]!.content).toBe('a')
    expect(appendToLastTurn([], 'x')[0]!.content).toBe('x')
  })

  it('ожидающие подтверждения вызовы', () => {
    const turns = [turn('', [tc('write_file', {}, { status: 'awaitingApproval', id: 'w1' }), tc('read_file', {})])]
    expect(awaitingCalls(turns).map((c) => c.id)).toEqual(['w1'])
    expect(awaitingCalls(undefined)).toEqual([])
  })
})
