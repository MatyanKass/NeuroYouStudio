// Системный прокси Windows для fetch в main-процессе. Node-fetch сам его не видит (в отличие от Chromium),
// поэтому спрашиваем у Electron, какой прокси нужен для huggingface.co, и включаем встроенную поддержку прокси Node.
import http from 'node:http'
import { session } from 'electron'

/** Локальные адреса (движки на 127.0.0.1) всегда напрямую. */
const NO_PROXY = 'localhost,127.0.0.1,::1'

/**
 * Ответ resolveProxy ("PROXY host:port; DIRECT") → переменные для http.setGlobalProxyFromEnv.
 * SOCKS Node не поддерживает — тогда null (работаем напрямую).
 */
export function proxyEnvFromPac(pac: string): { HTTP_PROXY: string; HTTPS_PROXY: string; NO_PROXY: string } | null {
  for (const raw of pac.split(';')) {
    const [kind, hostPort] = raw.trim().split(/\s+/)
    if (!kind) continue
    const k = kind.toUpperCase()
    if (k === 'DIRECT') return null
    if ((k === 'PROXY' || k === 'HTTP' || k === 'HTTPS') && hostPort) {
      const url = `${k === 'HTTPS' ? 'https' : 'http'}://${hostPort}`
      return { HTTP_PROXY: url, HTTPS_PROXY: url, NO_PROXY }
    }
  }
  return null
}

type SetProxy = (env: Record<string, string>) => unknown

/** Включает системный прокси для fetch (HuggingFace, загрузки движков). Явные переменные окружения важнее. */
export async function applySystemProxy(): Promise<string | null> {
  const e = process.env
  if (e.HTTPS_PROXY || e.https_proxy || e.HTTP_PROXY || e.http_proxy) return null
  const setProxy = (http as unknown as { setGlobalProxyFromEnv?: SetProxy }).setGlobalProxyFromEnv
  if (typeof setProxy !== 'function') return null
  const pac = await session.defaultSession.resolveProxy('https://huggingface.co')
  const env = proxyEnvFromPac(pac)
  if (!env) return null
  setProxy(env)
  return env.HTTPS_PROXY
}
