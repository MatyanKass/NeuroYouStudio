import { mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { HardwareInfo } from '@shared/types'
import { HfClient, HfError, describeHttpError, parseRepoQuery, resolveUrl } from '../../src/main/hf/client'
import { fetchModelDetails, markDownloaded } from '../../src/main/hf/details'
import { fileTarget, type RichOption } from '../../src/main/hf/options'
import { loadFixture, makeTempDir, startRouteServer, startServer, type TestServer } from './helpers'

const HW: HardwareInfo = {
  gpus: [{ index: 0, name: 'RTX', vramTotalMiB: 24576, vramFreeMiB: 24000, driverVersion: '', computeCap: '8.9' }],
  ramTotalMiB: 65536,
  ramFreeMiB: 50000,
  cpuName: '',
  cpuCores: 8,
  cpuThreads: 16,
  avx2: true,
  avx512: false
}

describe('parseRepoQuery', () => {
  it('распознаёт user/model и ссылки', () => {
    expect(parseRepoQuery('  unsloth/Qwen3-4B-GGUF ')).toEqual({ text: 'unsloth/Qwen3-4B-GGUF', repoId: 'unsloth/Qwen3-4B-GGUF', isUrl: false })
    expect(parseRepoQuery('https://huggingface.co/turboderp/Qwen3.5-9B-exl3/tree/4.00bpw').repoId).toBe('turboderp/Qwen3.5-9B-exl3')
    expect(parseRepoQuery('huggingface.co/a/b?x=1').repoId).toBe('a/b')
    expect(parseRepoQuery('https://hf.co/a/b').repoId).toBe('a/b')
    expect(parseRepoQuery('qwen3 4b')).toEqual({ text: 'qwen3 4b', isUrl: false })
    expect(parseRepoQuery('')).toEqual({ text: '', isUrl: false })
  })
  it('ссылка не на модель — понятная ошибка', () => {
    expect(() => parseRepoQuery('https://huggingface.co/datasets/a/b')).toThrow(/не ведёт на страницу модели/)
    expect(() => parseRepoQuery('https://huggingface.co/unsloth')).toThrow(HfError)
  })
})

describe('describeHttpError', () => {
  const h = (o: Record<string, string>): Headers => new Headers(o)
  it('gated / 401 / 404 / 429 / 5xx', () => {
    expect(describeHttpError(401, h({ 'x-error-code': 'GatedRepo' }), false).code).toBe('gated')
    expect(describeHttpError(403, h({ 'x-error-code': 'GatedRepo' }), true).message).toMatch(/примите условия/)
    expect(describeHttpError(401, h({}), false).message).toMatch(/не найден или приватный/)
    expect(describeHttpError(401, h({}), true).message).toMatch(/Токен HuggingFace недействителен/)
    expect(describeHttpError(404, h({ 'x-error-code': 'RevisionNotFound' }), false).message).toMatch(/Ветка/)
    const rl = describeHttpError(429, h({ ratelimit: '"api";r=0;t=30' }), false)
    expect(rl.code).toBe('rateLimit')
    expect(rl.retryAfterMs).toBe(30_000)
    expect(rl.message).toMatch(/Повторите через 30 с/)
    expect(describeHttpError(503, h({}), false).retryable).toBe(true)
    expect(describeHttpError(404, h({}), false).retryable).toBe(false)
  })
})

it('resolveUrl кодирует сегменты и ревизию', () => {
  expect(resolveUrl('https://huggingface.co', 'a/b', 'feat/x', 'dir/file name.gguf')).toBe(
    'https://huggingface.co/a/b/resolve/feat%2Fx/dir/file%20name.gguf'
  )
})

describe('HfClient + детали на записанных ответах HF', () => {
  let srv: TestServer
  let models: string

  beforeAll(async () => {
    const routes: Record<string, unknown> = {}
    for (const f of ['gguf-unsloth-qwen3.8-27b', 'gguf-qwen3-0.6b', 'exl3-turboderp-qwen3.5-9b', 'exl3-artusdev-electra-main']) {
      Object.assign(routes, await loadFixture(f))
    }
    routes['/api/models'] = await loadFixture('search-gguf-qwen3')
    srv = await startRouteServer(routes, (req, res) => {
      // эмуляция недействительного токена: с Authorization — 401
      if (req.url?.startsWith('/api/models/Qwen/Qwen3-0.6B-GGUF') && req.headers.authorization) {
        res.writeHead(401)
        res.end()
        return true
      }
      if (req.url?.startsWith('/api/models/limited/')) {
        res.writeHead(429, { RateLimit: '"api";r=0;t=12' })
        res.end()
        return true
      }
      return false
    })
  })
  afterAll(() => srv.close())
  beforeEach(async () => {
    models = await makeTempDir()
    srv.requests.length = 0
  })
  afterEach(() => rm(models, { recursive: true, force: true }))

  it('поиск: параметры запроса и разбор ответа', async () => {
    const client = new HfClient({ baseUrl: srv.base })
    const res = await client.search({ query: 'qwen3', format: 'gguf', sort: 'downloads', limit: 5 })
    expect(res).toHaveLength(5)
    expect(res[0]).toMatchObject({ format: 'gguf' })
    expect(typeof res[0]?.lastModified).toBe('string')
    expect(res[0]?.lastModified.length).toBeGreaterThan(0)
    expect(res[0]?.author).toBe(res[0]?.id.split('/')[0])
    const u = new URL(srv.requests[0]?.url ?? '', 'http://x')
    expect(u.searchParams.get('search')).toBe('qwen3')
    expect(u.searchParams.get('filter')).toBe('gguf')
    expect(u.searchParams.get('sort')).toBe('downloads')
    expect(u.searchParams.get('direction')).toBe('-1')
    expect(u.searchParams.get('limit')).toBe('5')
    expect(u.searchParams.getAll('expand[]')).toContain('lastModified')
  })

  it('поиск: пустой запрос — без search, фильтр exl3', async () => {
    const client = new HfClient({ baseUrl: srv.base })
    await client.search({ query: '', format: 'exl3', sort: 'trendingScore' })
    const u = new URL(srv.requests[0]?.url ?? '', 'http://x')
    expect(u.searchParams.has('search')).toBe(false)
    expect(u.searchParams.get('filter')).toBe('exl3')
    expect(u.searchParams.get('limit')).toBe('30')
  })

  it('поиск: user/model и ссылка → сразу этот репозиторий', async () => {
    const client = new HfClient({ baseUrl: srv.base })
    const a = await client.search({ query: 'unsloth/Qwen3.8-27B-GGUF', format: 'gguf', sort: 'downloads' })
    expect(a.map((m) => m.id)).toEqual(['unsloth/Qwen3.8-27B-GGUF'])
    const b = await client.search({
      query: 'https://huggingface.co/turboderp/Qwen3.5-9B-exl3',
      format: 'gguf',
      sort: 'downloads'
    })
    expect(b[0]).toMatchObject({ id: 'turboderp/Qwen3.5-9B-exl3', format: 'exl3', gated: false })
  })

  it('поиск: несуществующий user/model → обычный поиск', async () => {
    const client = new HfClient({ baseUrl: srv.base })
    const r = await client.search({ query: 'nobody/nothing', format: 'gguf', sort: 'likes' })
    expect(r.length).toBe(5)
    expect(srv.requests.at(-1)?.url).toMatch(/search=nobody%2Fnothing/)
  })

  it('токен отправляется; при 401 с токеном — повтор без токена', async () => {
    const client = new HfClient({ baseUrl: srv.base, getToken: async () => 'hf_test' })
    const info = await client.modelInfo('Qwen/Qwen3-0.6B-GGUF')
    expect(info.id).toBe('Qwen/Qwen3-0.6B-GGUF')
    expect(srv.requests[0]?.headers.authorization).toBe('Bearer hf_test')
    expect(srv.requests[1]?.headers.authorization).toBeUndefined()
  })

  it('429 → русская ошибка с временем ожидания', async () => {
    const client = new HfClient({ baseUrl: srv.base })
    await expect(client.modelInfo('limited/x')).rejects.toMatchObject({ code: 'rateLimit', message: expect.stringMatching(/12 с/) })
  })

  it('нет сети → понятная ошибка', async () => {
    const dead = await startServer(() => undefined)
    const base = dead.base
    await dead.close()
    const client = new HfClient({ baseUrl: base, timeoutMs: 3000 })
    await expect(client.search({ query: 'x', format: 'gguf', sort: 'likes' })).rejects.toMatchObject({
      code: 'network',
      message: expect.stringMatching(/Нет соединения/)
    })
  })

  it('детали GGUF: варианты, mmproj, описание, оценка', async () => {
    const client = new HfClient({ baseUrl: srv.base })
    const d = await fetchModelDetails({ client, modelsDir: models, hardware: HW }, 'unsloth/Qwen3.8-27B-GGUF', 'gguf')
    expect(d.id).toBe('unsloth/Qwen3.8-27B-GGUF')
    expect(d.gated).toBe(false)
    expect(d.options).toHaveLength(26)
    expect(d.mmproj).toHaveLength(2)
    expect(d.description.length).toBeGreaterThan(0)
    expect(d.description.length).toBeLessThanOrEqual(1501)
    expect(d.description.startsWith('---')).toBe(false)
    const q4 = d.options.find((o) => o.quant === 'UD-Q4_K_XL')
    expect(q4?.fit).toBe('full')
    expect(q4?.fitNote).toMatch(/VRAM/)
    expect(d.options.find((o) => o.quant === 'BF16')?.fit).toBe('partial')
    expect(d.options.every((o) => o.downloaded === false)).toBe(true)
    // README и tree запрошены, ветки — нет
    expect(srv.requests.some((r) => r.url.includes('/refs'))).toBe(false)
  })

  it('детали EXL3 (ветки turboderp): коммиты, без оценки при неизвестном железе', async () => {
    const client = new HfClient({ baseUrl: srv.base })
    const d = await fetchModelDetails({ client, modelsDir: models, hardware: null }, 'turboderp/Qwen3.5-9B-exl3', 'exl3')
    expect(d.options.map((o) => o.key)).toEqual(['2.00bpw', '2.50bpw', '3.00bpw', '3.50bpw', '4.00bpw', '5.00bpw', '6.00bpw'])
    expect(d.options.every((o) => o.fit === undefined)).toBe(true)
    expect(d.options[0]?.commit).toMatch(/^[0-9a-f]{40}$/)
    expect(d.mmproj).toEqual([])
  })

  it('детали EXL3 (main у ArtusDev) — проверка quant_method в config.json', async () => {
    const client = new HfClient({ baseUrl: srv.base })
    const d = await fetchModelDetails(
      { client, modelsDir: models, hardware: HW },
      'ArtusDev/L3.3-Electra-R1-70b_EXL3_2.5bpw_H8',
      'exl3'
    )
    expect(d.options.map((o) => [o.key, o.quant])).toEqual([['main', '2.5bpw_H8']])
    expect(d.options[0]?.fit).toBe('none')
    expect(srv.requests.some((r) => r.url.endsWith('/resolve/main/config.json'))).toBe(true)
  })

  it('markDownloaded: все файлы на месте с нужным размером', async () => {
    const opt = (key: string, files: Array<{ path: string; size: number }>): RichOption => ({
      key,
      label: key,
      quant: '',
      revision: 'main',
      files,
      sizeBytes: 0,
      downloaded: false,
      isMmproj: false
    })
    const a = opt('a.gguf', [{ path: 'sub/a.gguf', size: 4 }])
    const b = opt('b.gguf', [{ path: 'b.gguf', size: 10 }])
    const c = opt('c-00001-of-00002.gguf', [
      { path: 'c-00001-of-00002.gguf', size: 3 },
      { path: 'c-00002-of-00002.gguf', size: 3 }
    ])
    const put = async (p: string, size: number): Promise<void> => {
      const t = fileTarget(models, 'x/y', 'gguf', 'main', p)
      await mkdir(dirname(t), { recursive: true })
      await writeFile(t, Buffer.alloc(size))
    }
    await put('sub/a.gguf', 4)
    await put('b.gguf', 9)
    await put('c-00001-of-00002.gguf', 3)
    await markDownloaded([a, b, c], models, 'x/y', 'gguf')
    expect([a.downloaded, b.downloaded, c.downloaded]).toEqual([true, false, false])
  })
})
