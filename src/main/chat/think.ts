// Отделяет рассуждения <think>…</think> от ответа в потоке, если движок не сделал этого сам.

export interface ThinkSplitterOptions {
  /** Модель начинает сразу с рассуждения (открывающий тег стоит в шаблоне). */
  startsInThink?: boolean
  /** Продолжение уже начатого ответа: не срезать пробелы в начале и не искать «голый» закрывающий тег. */
  afterContent?: boolean
}

export interface ThinkPart {
  content: string
  reasoning: string
  /**
   * Встретился закрывающий тег без открывающего: шаблон сам открыл <think> в промпте (Qwen3, R1),
   * значит весь уже выданный «ответ» на самом деле был рассуждением.
   */
  reclassify?: boolean
}

export class ThinkSplitter {
  private pending = ''
  private inThink: boolean
  private emittedContent: boolean
  /** Пока не видели ни одного тега, закрывающий тег может оказаться «голым». */
  private sawTag: boolean
  /** Только что закрылся блок рассуждений: переводы строк после него не нужны. */
  private afterThink = false

  constructor(
    private readonly start: string,
    private readonly end: string,
    opts: ThinkSplitterOptions = {}
  ) {
    this.inThink = Boolean(opts.startsInThink)
    this.emittedContent = Boolean(opts.afterContent)
    this.sawTag = Boolean(opts.startsInThink || opts.afterContent)
  }

  /** Позиция «голого» закрывающего тега (не в `коде`), если он идёт раньше открывающего. */
  private bareEnd(): number {
    if (this.sawTag || this.inThink) return -1
    const e = this.pending.indexOf(this.end)
    if (e < 0) return -1
    const s = this.pending.indexOf(this.start)
    if (s >= 0 && s < e) return -1
    if (e > 0 && this.pending[e - 1] === '`') return -1
    return e
  }

  feed(text: string): ThinkPart {
    let content = ''
    let reasoning = ''
    let reclassify = false
    this.pending += text
    for (;;) {
      const bare = this.bareEnd()
      if (bare >= 0) {
        reasoning += this.pending.slice(0, bare)
        // Всё, что успели отдать как ответ, — тоже рассуждение.
        reasoning = content + reasoning
        content = ''
        reclassify = true
        this.pending = this.pending.slice(bare + this.end.length)
        this.sawTag = true
        this.emittedContent = false
        this.afterThink = true
        continue
      }
      const tag = this.inThink ? this.end : this.start
      const idx = this.pending.indexOf(tag)
      if (idx >= 0) {
        const before = this.pending.slice(0, idx)
        if (this.inThink) reasoning += before
        else content += before
        this.pending = this.pending.slice(idx + tag.length)
        if (this.inThink) this.afterThink = true
        this.inThink = !this.inThink
        this.sawTag = true
        continue
      }
      // Хвост может быть началом тега — придерживаем его.
      const tags = !this.inThink && !this.sawTag ? [tag, this.end] : [tag]
      let keep = 0
      for (const t of tags) {
        for (let k = Math.min(t.length - 1, this.pending.length); k > keep; k--) {
          if (t.startsWith(this.pending.slice(-k))) {
            keep = k
            break
          }
        }
      }
      const emit = this.pending.slice(0, this.pending.length - keep)
      this.pending = this.pending.slice(this.pending.length - keep)
      if (this.inThink) reasoning += emit
      else content += emit
      break
    }
    return { ...this.trimContent(content), reasoning, ...(reclassify ? { reclassify } : {}) }
  }

  /**
   * Пробелы/переводы строк в начале ответа не нужны. После блока рассуждений посреди ответа
   * (продолжение: ik_llama вставляет пустой <think></think>) убираем только переводы строк.
   */
  private trimContent(text: string): { content: string } {
    let content = text
    if (!this.emittedContent) content = content.replace(/^\s+/, '')
    else if (this.afterThink) content = content.replace(/^[\r\n]+/, '')
    if (content) {
      this.emittedContent = true
      this.afterThink = false
    }
    return { content }
  }

  flush(): ThinkPart {
    const rest = this.pending
    this.pending = ''
    if (this.inThink) return { content: '', reasoning: rest }
    return { ...this.trimContent(rest), reasoning: '' }
  }
}
