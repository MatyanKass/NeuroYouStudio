import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ session: { defaultSession: { resolveProxy: async () => 'DIRECT' } } }))

const { writeJson } = await import('./json-file')
const { proxyEnvFromPac } = await import('./system-proxy')

const dir = mkdtempSync(join(tmpdir(), 'nys-util-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe('writeJson', () => {
  it('параллельные записи в один файл: без сбоев, на диске — последняя, временных файлов нет', async () => {
    const p = join(dir, 'a.json')
    await Promise.all(Array.from({ length: 30 }, (_, i) => writeJson(p, { i })))
    expect(JSON.parse(readFileSync(p, 'utf8'))).toEqual({ i: 29 })
    expect(readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([])
  })
  it('пишет снимок на момент вызова, а не изменённый позже объект', async () => {
    const p = join(dir, 'b.json')
    const obj = { v: 1 }
    const w = writeJson(p, obj)
    obj.v = 2
    await w
    expect(JSON.parse(readFileSync(p, 'utf8'))).toEqual({ v: 1 })
  })
})

describe('системный прокси', () => {
  it('PROXY → переменные для Node, локальные адреса напрямую', () => {
    expect(proxyEnvFromPac('PROXY 10.0.0.1:3128; DIRECT')).toEqual({
      HTTP_PROXY: 'http://10.0.0.1:3128',
      HTTPS_PROXY: 'http://10.0.0.1:3128',
      NO_PROXY: 'localhost,127.0.0.1,::1'
    })
  })
  it('DIRECT и SOCKS — без прокси', () => {
    expect(proxyEnvFromPac('DIRECT')).toBeNull()
    expect(proxyEnvFromPac('SOCKS5 127.0.0.1:1080')).toBeNull()
    expect(proxyEnvFromPac('')).toBeNull()
  })
})
