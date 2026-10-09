// Ключ API движка: свой на каждый запуск, чтобы страницы в браузере не могли обращаться к серверу на 127.0.0.1.
import { randomBytes } from 'node:crypto'

/** Случайный ключ (192 бита, base64url — без символов, требующих экранирования). */
export function newApiKey(): string {
  return randomBytes(24).toString('base64url')
}

/** Заголовок авторизации для запросов к движку (пустой, если ключа нет). */
export function authHeaders(apiKey?: string): Record<string, string> {
  return apiKey ? { Authorization: `Bearer ${apiKey}` } : {}
}
