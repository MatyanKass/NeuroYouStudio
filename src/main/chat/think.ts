// Отделяет рассуждения <think>…</think> от ответа в потоке, если движок не сделал этого сам.

export class ThinkSplitter {
  private pending = ''
  private inThink = false
  private emittedContent = false

  constructor(
    private readonly start: string,
    private readonly end: string,
    /** Модель начинает сразу с рассуждения (открывающий тег стоит в шаблоне). */
    startsInThink = false
  ) {
    this.inThink = startsInThink
  }

  feed(text: string): { content: string; reasoning: string } {
    let content = ''
    let reasoning = ''
    this.pending += text
    for (;;) {
      const tag = this.inThink ? this.end : this.start
      const idx = this.pending.indexOf(tag)
      if (idx >= 0) {
        const before = this.pending.slice(0, idx)
        if (this.inThink) reasoning += before
        else content += before
        this.pending = this.pending.slice(idx + tag.length)
        this.inThink = !this.inThink
        continue
      }
      // Хвост может быть началом тега — придерживаем его.
      let keep = 0
      for (let k = Math.min(tag.length - 1, this.pending.length); k > 0; k--) {
        if (tag.startsWith(this.pending.slice(-k))) {
          keep = k
          break
        }
      }
      const emit = this.pending.slice(0, this.pending.length - keep)
      this.pending = this.pending.slice(this.pending.length - keep)
      if (this.inThink) reasoning += emit
      else content += emit
      break
    }
    // Пробелы/переводы строк сразу после рассуждения в начале ответа не нужны.
    if (!this.emittedContent) content = content.replace(/^\s+/, '')
    if (content) this.emittedContent = true
    return { content, reasoning }
  }

  flush(): { content: string; reasoning: string } {
    const rest = this.pending
    this.pending = ''
    return this.inThink ? { content: '', reasoning: rest } : { content: rest, reasoning: '' }
  }
}
