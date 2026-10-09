// Разбор потока Server-Sent Events (OpenAI-совместимый стриминг).

export class SseParser {
  private buf = ''

  /** Добавляет кусок текста, возвращает готовые data-полезные нагрузки. */
  push(chunk: string): string[] {
    this.buf += chunk
    const out: string[] = []
    let idx: number
    while ((idx = this.buf.search(/\r?\n\r?\n/)) >= 0) {
      const block = this.buf.slice(0, idx)
      const sep = this.buf.slice(idx).match(/^\r?\n\r?\n/)?.[0].length ?? 2
      this.buf = this.buf.slice(idx + sep)
      const data = block
        .split(/\r?\n/)
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).replace(/^ /, ''))
        .join('\n')
      if (data) out.push(data)
    }
    return out
  }
}
