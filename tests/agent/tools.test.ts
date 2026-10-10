import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { executeTool, isReadOnlyTool, resolvePath, shellSpec, truncate, type ToolContext } from '../../src/main/agent/tools'

let dir: string
const ctx = (over: Partial<ToolContext> = {}): ToolContext => ({
  cwd: dir,
  defaultShell: 'powershell',
  commandTimeoutSec: 30,
  maxOutputChars: 20000,
  signal: new AbortController().signal,
  ...over
})

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'nys-agent-'))
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe('инструменты файлов', () => {
  it('read_file: номера строк, окно offset/limit, двоичный файл', async () => {
    writeFileSync(join(dir, 'a.txt'), 'один\nдва\nтри\nчетыре')
    const r = await executeTool('read_file', { path: 'a.txt' }, ctx())
    expect(r.content).toContain('1\tодин')
    expect(r.content).toContain('4\tчетыре')
    const win = await executeTool('read_file', { path: 'a.txt', offset: 2, limit: 2 }, ctx())
    expect(win.content).toContain('2\tдва')
    expect(win.content).toContain('3\tтри')
    expect(win.content).not.toContain('один')
    writeFileSync(join(dir, 'bin.dat'), Buffer.from([0, 1, 2, 0, 65]))
    const bin = await executeTool('read_file', { path: 'bin.dat' }, ctx())
    expect(bin.content).toContain('Двоичный')
  })

  it('list_dir: файлы с размером и вложенность', async () => {
    writeFileSync(join(dir, 'sub-marker.txt'), 'hello')
    const r = await executeTool('list_dir', { path: '.' }, ctx())
    expect(r.content).toContain('sub-marker.txt')
    expect(r.content).toMatch(/sub-marker\.txt \(\d+ б\)/)
  })

  it('search_files: regex, glob, пропуск двоичных', async () => {
    writeFileSync(join(dir, 'code.ts'), 'const foo = 1\nconst bar = 2')
    writeFileSync(join(dir, 'other.js'), 'const foo = 3')
    const r = await executeTool('search_files', { path: '.', pattern: 'foo', glob: '*.ts' }, ctx())
    expect(r.content).toContain('code.ts')
    expect(r.content).not.toContain('other.js')
    const bad = await executeTool('search_files', { path: '.', pattern: '(' }, ctx())
    expect(bad.isError).toBe(true)
  })

  it('write_file: создаёт, mkdir -p, diff', async () => {
    const r = await executeTool('write_file', { path: 'nested/deep/new.txt', content: 'привет\nмир' }, ctx())
    expect(r.isError).toBeFalsy()
    expect(readFileSync(join(dir, 'nested/deep/new.txt'), 'utf8')).toBe('привет\nмир')
    expect(r.diff).toContain('+привет')
  })

  it('edit_file: замена, ошибка если не найдено или не уникально', async () => {
    writeFileSync(join(dir, 'e.txt'), 'alpha beta alpha')
    const notFound = await executeTool('edit_file', { path: 'e.txt', old_string: 'zeta', new_string: 'x' }, ctx())
    expect(notFound.isError).toBe(true)
    expect(notFound.content).toContain('не найден')
    const notUnique = await executeTool('edit_file', { path: 'e.txt', old_string: 'alpha', new_string: 'x' }, ctx())
    expect(notUnique.isError).toBe(true)
    const ok = await executeTool('edit_file', { path: 'e.txt', old_string: 'beta', new_string: 'GAMMA' }, ctx())
    expect(ok.isError).toBeFalsy()
    expect(readFileSync(join(dir, 'e.txt'), 'utf8')).toBe('alpha GAMMA alpha')
    const all = await executeTool('edit_file', { path: 'e.txt', old_string: 'alpha', new_string: 'A', replace_all: true }, ctx())
    expect(all.isError).toBeFalsy()
    expect(readFileSync(join(dir, 'e.txt'), 'utf8')).toBe('A GAMMA A')
  })

  it('resolvePath: относительный и абсолютный', () => {
    expect(resolvePath(dir, 'a.txt')).toBe(join(dir, 'a.txt'))
    expect(resolvePath(dir, 'C:/x/y.txt')).toBe(join('C:/x/y.txt'))
  })

  it('isReadOnlyTool', () => {
    expect(isReadOnlyTool('read_file')).toBe(true)
    expect(isReadOnlyTool('write_file')).toBe(false)
  })

  it('truncate: голова + хвост', () => {
    const t = truncate('a'.repeat(100) + 'b'.repeat(100), 50)
    expect(t).toContain('пропущено')
    expect(t.length).toBeLessThan(120)
  })
})

describe('run_command (Windows)', () => {
  it('PowerShell: вывод кириллицы UTF-8 и код возврата', async () => {
    const r = await executeTool('run_command', { command: 'Write-Output "Привет мир"', shell: 'powershell' }, ctx())
    expect(r.content).toContain('Привет мир')
    expect(r.exitCode).toBe(0)
    expect(r.isError).toBeFalsy()
  }, 30_000)

  it('cmd: вывод кириллицы в UTF-8 (type файла) и код возврата', async () => {
    // Литеральная кириллица прямо в строке cmd ненадёжна (cmd разбирает строку до chcp),
    // поэтому проверяем декодирование UTF-8-вывода: type UTF-8-файла.
    writeFileSync(join(dir, 'ru.txt'), 'Привет из cmd')
    const r = await executeTool('run_command', { command: 'type ru.txt', shell: 'cmd' }, ctx())
    expect(r.content).toContain('Привет из cmd')
    expect(r.exitCode).toBe(0)
  }, 30_000)

  it('ненулевой код возврата = ошибка', async () => {
    const r = await executeTool('run_command', { command: 'exit 3', shell: 'cmd' }, ctx())
    expect(r.exitCode).toBe(3)
    expect(r.isError).toBe(true)
  }, 30_000)

  it('тайм-аут убивает дерево процессов', async () => {
    const r = await executeTool(
      'run_command',
      { command: 'Start-Sleep -Seconds 30', shell: 'powershell', timeout_sec: 2 },
      ctx()
    )
    expect(r.content).toContain('тайм-аут')
    expect(r.isError).toBe(true)
  }, 30_000)

  it('cwd команды учитывается', async () => {
    const r = await executeTool('run_command', { command: 'Get-Location | Select-Object -ExpandProperty Path' }, ctx())
    expect(r.content.toLowerCase()).toContain(dir.toLowerCase().slice(3, 15))
  }, 30_000)
})

describe('shellSpec', () => {
  it('powershell: без профиля, UTF-8, абсолютный путь', () => {
    const s = shellSpec('powershell', 'ls')
    expect(s.exe).toMatch(/powershell\.exe$/i)
    expect(s.args).toContain('-NonInteractive')
    expect(s.args[s.args.length - 1]).toContain('OutputEncoding')
  })
  it('cmd: chcp 65001, абсолютный путь', () => {
    const s = shellSpec('cmd', 'dir')
    expect(s.exe).toMatch(/cmd\.exe$/i)
    expect(s.args[s.args.length - 1]).toContain('chcp 65001')
  })
})
