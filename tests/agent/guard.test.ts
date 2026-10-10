import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const h = vi.hoisted(() => ({ dir: '' }))
vi.mock('electron', () => ({
  app: { getPath: () => h.dir, getVersion: () => '0.0.0', isPackaged: false },
  ipcMain: { handle: () => undefined },
  BrowserWindow: { getAllWindows: () => [] },
  safeStorage: { isEncryptionAvailable: () => false }
}))

h.dir = mkdtempSync(join(tmpdir(), 'nys-guard-'))
const { parseVerdict, GUARD_MODEL } = await import('../../src/main/agent/guard')

beforeAll(() => undefined)
afterAll(() => rmSync(h.dir, { recursive: true, force: true }))

describe('parseVerdict', () => {
  it('разбирает чистый JSON', () => {
    expect(parseVerdict('{"level":"block","reason":"опасно"}')).toEqual({ level: 'block', reason: 'опасно', by: 'guard' })
  })
  it('выдёргивает JSON из обрамляющего текста', () => {
    const v = parseVerdict('Вот вердикт: {"level":"ask","reason":"удаление"} — конец')
    expect(v).toMatchObject({ level: 'ask', reason: 'удаление' })
  })
  it('без reason — пустая строка', () => {
    expect(parseVerdict('{"level":"safe"}')).toEqual({ level: 'safe', reason: '', by: 'guard' })
  })
  it('мусор или неверный уровень → null', () => {
    expect(parseVerdict('не json')).toBeNull()
    expect(parseVerdict('{"level":"maybe"}')).toBeNull()
  })
})

describe('GUARD_MODEL', () => {
  it('задан конкретный репозиторий и файл', () => {
    expect(GUARD_MODEL.repo).toBe('unsloth/Qwen3.5-2B-GGUF')
    expect(GUARD_MODEL.file).toMatch(/\.gguf$/)
    expect(GUARD_MODEL.modelId).toContain(GUARD_MODEL.file)
  })
})
