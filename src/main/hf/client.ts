// Клиент HuggingFace Hub API (без Electron: токен и fetch передаются снаружи).
import type { ModelFormat } from '@shared/config'
import type { HfSearchQuery } from '@shared/ipc'
import type { HfModelSummary } from '@shared/types'
import type { HfTreeEntry } from './options'

export const HF_BASE_URL = 'https://huggingface.co'
export const USER_AGENT = 'NeuroYouStudio/0.1'

export type HfErrorCode =
  | 'network'
  | 'timeout'
  | 'auth'
  | 'gated'
  | 'notFound'
  | 'rateLimit'
  | 'server'
  | 'http'
  | 'disk'
  | 'integrity'
  | 'input'

export class HfError extends Error {
  readonly code: HfErrorCode
  readonly status?: number
  readonly retryAfterMs?: number

  constructor(message: string, code: HfErrorCode, opts: { status?: number; retryAfterMs?: number; cause?: unknown } = {}) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause })
    this.code = code
    this.status = opts.status
    this.retryAfterMs = opts.retryAfterMs
  }

  /** Имеет смысл повторить запрос позже. */
  get retryable(): boolean {
    return this.code === 'network' || this.code === 'timeout' || this.code === 'rateLimit' || this.code === 'server'
  }
}

/** Retry-After (секунды или дата) либо RateLimit: "api";r=0;t=123 → мс. */
export function parseRetryAfter(headers: Headers): number | undefined {
  const ra = headers.get('retry-after')
  if (ra) {
    const sec = Number(ra)
    if (Number.isFinite(sec)) return Math.max(0, sec * 1000)
    const at = Date.parse(ra)
    if (Number.isFinite(at)) return Math.max(0, at - Date.now())
  }
  const rl = /;\s*t=(\d+)/.exec(headers.get('ratelimit') ?? '')
  return rl ? Number(rl[1]) * 1000 : undefined
}

export function describeHttpError(status: number, headers: Headers, hasToken: boolean): HfError {
  const code = headers.get('x-error-code') ?? ''
  const msg = headers.get('x-error-message') ?? ''
  if (code === 'GatedRepo' || (status === 403 && /gated|restricted/i.test(msg))) {
    return new HfError(
      hasToken
        ? 'Нет доступа к закрытой (gated) модели: откройте её страницу на huggingface.co и примите условия.'
        : 'Модель закрытая (gated): примите условия на странице модели на huggingface.co и укажите токен HuggingFace в настройках.',
      'gated',
      { status }
    )
  }
  if (status === 401) {
    return new HfError(
      hasToken
        ? 'Токен HuggingFace недействителен, либо репозиторий не найден или приватный.'
        : 'Репозиторий не найден или приватный (для приватных нужен токен HuggingFace).',
      'auth',
      { status }
    )
  }
  if (status === 403) return new HfError('HuggingFace отказал в доступе (403).', 'auth', { status })
  if (status === 404) {
    const text =
      code === 'RevisionNotFound'
        ? 'Ветка репозитория не найдена.'
        : code === 'EntryNotFound'
          ? 'Файл не найден в репозитории.'
          : code === 'RepoNotFound'
            ? 'Репозиторий не найден.'
            : 'Не найдено на HuggingFace (404).'
    return new HfError(text, 'notFound', { status })
  }
  if (status === 429) {
    const retryAfterMs = parseRetryAfter(headers)
    const wait = retryAfterMs !== undefined ? ` Повторите через ${Math.ceil(retryAfterMs / 1000)} с.` : ' Подождите немного.'
    return new HfError(`HuggingFace ограничил частоту запросов.${wait}`, 'rateLimit', { status, retryAfterMs })
  }
  if (status >= 500) {
    return new HfError(`Сервер HuggingFace временно недоступен (код ${status}). Попробуйте позже.`, 'server', {
      status,
      retryAfterMs: parseRetryAfter(headers)
    })
  }
  return new HfError(`Ошибка HuggingFace: HTTP ${status}.`, 'http', { status })
}

function errCode(e: unknown): string {
  let cur: unknown = e
  for (let i = 0; i < 4 && cur && typeof cur === 'object'; i++) {
    const c = (cur as { code?: unknown }).code
    if (typeof c === 'string') return c
    cur = (cur as { cause?: unknown }).cause
  }
  return ''
}

/** Сетевые ошибки fetch → понятный текст. */
export function describeFetchError(e: unknown): HfError {
  if (e instanceof HfError) return e
  const name = (e as { name?: string } | null)?.name
  if (name === 'TimeoutError') {
    return new HfError('HuggingFace не ответил вовремя. Проверьте подключение к интернету.', 'timeout', { cause: e })
  }
  const code = errCode(e)
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    return new HfError('Нет соединения с huggingface.co (не удаётся найти сервер). Проверьте интернет.', 'network', { cause: e })
  }
  if (/CERT|SSL|TLS|SELF_SIGNED/i.test(code)) {
    return new HfError('Ошибка защищённого соединения с huggingface.co (прокси или антивирус?).', 'network', { cause: e })
  }
  return new HfError('Нет соединения с huggingface.co. Проверьте подключение к интернету.', 'network', { cause: e })
}

export const repoPath = (repoId: string): string => repoId.split('/').map(encodeURIComponent).join('/')
const filePathEnc = (p: string): string => p.split('/').map(encodeURIComponent).join('/')

/** URL файла: {base}/{repo}/resolve/{rev}/{path}. */
export function resolveUrl(baseUrl: string, repoId: string, rev: string, filePath: string): string {
  return `${baseUrl}/${repoPath(repoId)}/resolve/${encodeURIComponent(rev)}/${filePathEnc(filePath)}`
}

function nextLink(link: string | null): string | null {
  if (!link) return null
  const m = /<([^>]+)>\s*;\s*rel="?next"?/i.exec(link)
  return m ? (m[1] ?? null) : null
}

const NON_MODEL_SEGMENTS = new Set([
  'datasets',
  'spaces',
  'models',
  'docs',
  'blog',
  'collections',
  'papers',
  'organizations',
  'settings',
  'login',
  'join',
  'api'
])

/** «user/model» или ссылка huggingface.co/user/model → repoId. */
export function parseRepoQuery(query: string): { text: string; repoId?: string; isUrl: boolean } {
  const text = query.trim()
  const url = /^(?:https?:\/\/)?(?:www\.)?(?:huggingface\.co|hf\.co)\/([^/?#\s]+)(?:\/([^/?#\s]+))?/i.exec(text)
  if (url) {
    const a = decodeURIComponent(url[1] ?? '')
    const b = url[2] ? decodeURIComponent(url[2]) : ''
    if (NON_MODEL_SEGMENTS.has(a.toLowerCase()) || !b) {
      throw new HfError('Ссылка не ведёт на страницу модели HuggingFace (нужен вид huggingface.co/автор/модель).', 'input')
    }
    return { text, repoId: `${a}/${b.replace(/\.git$/i, '')}`, isUrl: true }
  }
  if (/^[\w.-]+\/[\w.-]+$/.test(text)) return { text, repoId: text, isUrl: false }
  return { text, isUrl: false }
}

export interface HfModelInfo {
  id: string
  author?: string
  sha?: string
  gated?: boolean | string
  private?: boolean
  tags?: string[]
  downloads?: number
  likes?: number
  lastModified?: string
  createdAt?: string
  pipeline_tag?: string
}

export interface HfRefs {
  branches: Array<{ name: string; targetCommit?: string }>
}

export function toSummary(m: HfModelInfo, format: ModelFormat): HfModelSummary {
  const tags = Array.isArray(m.tags) ? m.tags : []
  const other: ModelFormat = format === 'gguf' ? 'exl3' : 'gguf'
  const detected = tags.includes(format) ? format : tags.includes(other) ? other : format
  return {
    id: m.id,
    author: m.author ?? m.id.split('/')[0] ?? '',
    downloads: m.downloads ?? 0,
    likes: m.likes ?? 0,
    lastModified: m.lastModified ?? m.createdAt ?? '',
    tags,
    format: detected,
    gated: Boolean(m.gated),
    ...(m.pipeline_tag ? { pipelineTag: m.pipeline_tag } : {})
  }
}

const SEARCH_EXPAND = ['downloads', 'likes', 'lastModified', 'tags', 'author', 'gated', 'pipeline_tag']

export interface HfClientOptions {
  baseUrl?: string
  getToken?: () => Promise<string | null> | string | null
  timeoutMs?: number
  fetchImpl?: typeof fetch
}

export class HfClient {
  readonly baseUrl: string
  private readonly getToken: () => Promise<string | null> | string | null
  private readonly timeoutMs: number
  private readonly fetchImpl: typeof fetch

  constructor(opts: HfClientOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? HF_BASE_URL).replace(/\/+$/, '')
    this.getToken = opts.getToken ?? (() => null)
    this.timeoutMs = opts.timeoutMs ?? 20_000
    this.fetchImpl = opts.fetchImpl ?? fetch
  }

  async token(): Promise<string | null> {
    try {
      const t = await this.getToken()
      return t && t.trim() ? t.trim() : null
    } catch {
      return null
    }
  }

  /** GET с таймаутом и понятными ошибками. При 401 с токеном пробует без токена (публичные ресурсы). */
  async request(pathOrUrl: string, opts: { timeoutMs?: number; accept?: string } = {}): Promise<Response> {
    const url = /^https?:\/\//i.test(pathOrUrl) ? pathOrUrl : `${this.baseUrl}${pathOrUrl}`
    const sameOrigin = new URL(url).origin === new URL(this.baseUrl).origin
    const token = sameOrigin ? await this.token() : null
    let res = await this.send(url, token, opts)
    if (res.status === 401 && token && res.headers.get('x-error-code') !== 'GatedRepo') {
      await res.body?.cancel().catch(() => undefined)
      const anon = await this.send(url, null, opts)
      if (anon.ok) return anon
      res = anon
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined)
      throw describeHttpError(res.status, res.headers, Boolean(token))
    }
    return res
  }

  private async send(url: string, token: string | null, opts: { timeoutMs?: number; accept?: string }): Promise<Response> {
    const headers: Record<string, string> = { Accept: opts.accept ?? 'application/json', 'User-Agent': USER_AGENT }
    if (token) headers.Authorization = `Bearer ${token}`
    try {
      return await this.fetchImpl(url, {
        headers,
        redirect: 'follow',
        signal: AbortSignal.timeout(opts.timeoutMs ?? this.timeoutMs)
      })
    } catch (e) {
      throw describeFetchError(e)
    }
  }

  async getJson<T>(pathOrUrl: string, timeoutMs?: number): Promise<{ data: T; res: Response }> {
    const res = await this.request(pathOrUrl, { timeoutMs })
    try {
      return { data: (await res.json()) as T, res }
    } catch (e) {
      if (e instanceof SyntaxError) throw new HfError('HuggingFace вернул некорректный ответ.', 'http', { cause: e })
      throw describeFetchError(e)
    }
  }

  async search(q: HfSearchQuery): Promise<HfModelSummary[]> {
    const parsed = parseRepoQuery(q.query)
    if (parsed.repoId) {
      try {
        return [toSummary(await this.modelInfo(parsed.repoId), q.format)]
      } catch (e) {
        const fallback = e instanceof HfError && (e.code === 'notFound' || e.code === 'auth')
        if (parsed.isUrl || !fallback) throw e
      }
    }
    const params = new URLSearchParams()
    if (parsed.text) params.set('search', parsed.text)
    params.set('filter', q.format)
    params.set('sort', q.sort)
    params.set('direction', '-1')
    params.set('limit', String(Math.min(100, Math.max(1, Math.floor(q.limit ?? 30)))))
    for (const e of SEARCH_EXPAND) params.append('expand[]', e)
    const { data } = await this.getJson<HfModelInfo[]>(`/api/models?${params.toString()}`)
    if (!Array.isArray(data)) throw new HfError('HuggingFace вернул некорректный ответ.', 'http')
    return data.filter((m) => m && typeof m.id === 'string').map((m) => ({ ...toSummary(m, q.format), format: q.format }))
  }

  async modelInfo(repoId: string): Promise<HfModelInfo> {
    const { data } = await this.getJson<HfModelInfo>(`/api/models/${repoPath(repoId)}`)
    if (!data || typeof data.id !== 'string') throw new HfError('HuggingFace вернул некорректный ответ.', 'http')
    return data
  }

  async refs(repoId: string): Promise<HfRefs> {
    const { data } = await this.getJson<HfRefs>(`/api/models/${repoPath(repoId)}/refs`)
    return { branches: Array.isArray(data?.branches) ? data.branches.filter((b) => typeof b?.name === 'string') : [] }
  }

  /** Полный список файлов ревизии (рекурсивно, с постраничной выдачей). */
  async tree(repoId: string, rev: string): Promise<HfTreeEntry[]> {
    const out: HfTreeEntry[] = []
    let url: string | null = `/api/models/${repoPath(repoId)}/tree/${encodeURIComponent(rev)}?recursive=true`
    for (let page = 0; url && page < 100; page++) {
      const { data, res }: { data: HfTreeEntry[]; res: Response } = await this.getJson<HfTreeEntry[]>(url, 30_000)
      if (!Array.isArray(data)) throw new HfError('HuggingFace вернул некорректный список файлов.', 'http')
      out.push(...data)
      url = nextLink(res.headers.get('link'))
    }
    return out
  }

  /** Текст небольшого файла репозитория; null, если файла нет. */
  async fileText(repoId: string, rev: string, path: string): Promise<string | null> {
    try {
      const res = await this.request(resolveUrl(this.baseUrl, repoId, rev, path), { accept: '*/*' })
      return await res.text()
    } catch (e) {
      if (e instanceof HfError && e.code === 'notFound') return null
      throw describeFetchError(e)
    }
  }

  async readme(repoId: string): Promise<string> {
    return (await this.fileText(repoId, 'main', 'README.md')) ?? ''
  }
}
