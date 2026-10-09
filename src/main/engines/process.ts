// Процесс llama-server: запуск, журнал, ожидание готовности, остановка. Без electron.
import { spawn, execFile, type ChildProcess } from 'node:child_process'
import { createWriteStream, mkdirSync, type WriteStream } from 'node:fs'
import { createServer } from 'node:net'
import { dirname } from 'node:path'
import type { LaunchSpec, HealthState } from './types'
import { errorHint, type LogEvent, type LogParser } from './log-parser'

export const RING_SIZE = 3000

/** Свободный TCP-порт на 127.0.0.1. */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.unref()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      srv.close(() => (port ? resolve(port) : reject(new Error('Не удалось получить свободный порт'))))
    })
  })
}

export class EngineError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly details: string[] = []
  ) {
    super(message)
    this.name = 'EngineError'
  }
}

export interface EngineProcessOptions {
  spec: LaunchSpec
  port: number
  parser: LogParser
  healthcheck: (baseUrl: string, signal?: AbortSignal) => Promise<HealthState>
  /** Файл журнала (дописывается). */
  logFile?: string
  onLine?: (line: string) => void
  onEvent?: (ev: LogEvent) => void
  onExit?: (code: number | null, signal: NodeJS.Signals | null) => void
  /** Сколько ждать без новых строк в журнале, мс (по умолчанию 10 мин). */
  idleTimeoutMs?: number
  /** Абсолютный предел загрузки, мс (по умолчанию 45 мин). */
  maxLoadMs?: number
  healthIntervalMs?: number
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export class EngineProcess {
  readonly port: number
  readonly baseUrl: string
  private child: ChildProcess | null = null
  private readonly ring: string[] = []
  private log: WriteStream | null = null
  private exitInfo: { code: number | null; signal: NodeJS.Signals | null } | null = null
  private exitWaiters: Array<() => void> = []
  private lastActivity = Date.now()
  private stopping = false
  private partial = { out: '', err: '' }

  constructor(private readonly opts: EngineProcessOptions) {
    this.port = opts.port
    this.baseUrl = `http://127.0.0.1:${opts.port}`
  }

  get pid(): number | undefined {
    return this.child?.pid
  }

  get exited(): boolean {
    return this.exitInfo !== null
  }

  get lines(): string[] {
    return [...this.ring]
  }

  get parser(): LogParser {
    return this.opts.parser
  }

  start(): void {
    const { spec } = this.opts
    if (this.opts.logFile) {
      try {
        mkdirSync(dirname(this.opts.logFile), { recursive: true })
        this.log = createWriteStream(this.opts.logFile, { flags: 'a' })
        this.log.on('error', () => (this.log = null))
        this.log.write(`\n===== ${new Date().toISOString()} ${spec.exe} ${spec.args.map(quote).join(' ')}\n`)
      } catch {
        this.log = null
      }
    }
    const child = spawn(spec.exe, spec.args, {
      cwd: spec.cwd,
      env: spec.env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    this.child = child
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (d: string) => this.onData('out', d))
    child.stderr?.on('data', (d: string) => this.onData('err', d))
    child.on('error', (e) => {
      this.pushLine(`[NeuroYouStudio] не удалось запустить ${spec.exe}: ${e.message}`)
      this.markExit(null, null)
    })
    child.on('exit', (code, signal) => {
      for (const k of ['out', 'err'] as const) {
        if (this.partial[k]) this.pushLine(this.partial[k])
        this.partial[k] = ''
      }
      this.markExit(code, signal)
    })
  }

  private markExit(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.exitInfo) return
    this.exitInfo = { code, signal }
    this.log?.write(`===== процесс завершён (код ${code ?? signal ?? '?'})\n`)
    this.log?.end()
    this.log = null
    for (const w of this.exitWaiters.splice(0)) w()
    this.opts.onExit?.(code, signal)
  }

  private onData(stream: 'out' | 'err', d: string): void {
    this.lastActivity = Date.now()
    const buf = this.partial[stream] + d
    const parts = buf.split(/\r?\n/)
    this.partial[stream] = parts.pop() ?? ''
    for (const line of parts) this.pushLine(line)
  }

  private pushLine(line: string): void {
    this.ring.push(line)
    if (this.ring.length > RING_SIZE) this.ring.splice(0, this.ring.length - RING_SIZE)
    this.log?.write(line + '\n')
    this.opts.onLine?.(line)
    for (const ev of this.opts.parser.feed(line)) this.opts.onEvent?.(ev)
  }

  private waitExit(timeoutMs: number): Promise<boolean> {
    if (this.exitInfo) return Promise.resolve(true)
    return new Promise((resolve) => {
      const t = setTimeout(() => resolve(false), timeoutMs)
      this.exitWaiters.push(() => {
        clearTimeout(t)
        resolve(true)
      })
    })
  }

  /** Ошибка с самыми полезными строками журнала и подсказкой. */
  failure(fallback: string): EngineError {
    const fatal = this.opts.parser.fatal
    const tail = this.ring.filter((l) => l.trim()).slice(-15)
    const errLines = this.ring.filter((l) => /error|failed|out of memory|unknown argument|invalid/i.test(l)).slice(-8)
    const details = errLines.length ? errLines : tail
    if (fatal) {
      return new EngineError(`${errorHint(fatal.code, fatal.arg)}\n\n${fatal.message}`, fatal.code, details)
    }
    const last = details.at(-1)
    return new EngineError(last ? `${fallback}\n\n${last.trim()}` : fallback, 'other', details)
  }

  /** Ждёт ответа 200 от /health. Отклоняется при выходе процесса, тайм-ауте или отмене. */
  async waitReady(signal?: AbortSignal): Promise<void> {
    const idle = this.opts.idleTimeoutMs ?? 10 * 60_000
    const maxMs = this.opts.maxLoadMs ?? 45 * 60_000
    const every = this.opts.healthIntervalMs ?? 500
    const started = Date.now()
    let lastState: HealthState = 'down'
    for (;;) {
      if (signal?.aborted) throw new EngineError('Загрузка отменена', 'aborted')
      if (this.exitInfo) {
        const code = this.exitInfo.code
        throw this.failure(`Движок завершился при загрузке (код ${code ?? this.exitInfo.signal ?? '?'})`)
      }
      const now = Date.now()
      if (now - this.lastActivity > idle || now - started > maxMs) {
        throw new EngineError(
          'Движок слишком долго не отвечает — загрузка прервана. Проверьте журнал движка.',
          'timeout',
          this.ring.slice(-15)
        )
      }
      const state = await this.opts.healthcheck(this.baseUrl, signal).catch((): HealthState => 'down')
      if (state === 'ready') return
      if (state !== lastState) {
        // Смена состояния тоже считается признаком жизни.
        this.lastActivity = Date.now()
        lastState = state
      }
      await sleep(every)
    }
  }

  /** Принудительная остановка всего дерева процессов. */
  async stop(): Promise<void> {
    const child = this.child
    if (!child || this.exitInfo || this.stopping) {
      if (this.stopping) await this.waitExit(10_000)
      return
    }
    this.stopping = true
    if (process.platform === 'win32' && child.pid) {
      await new Promise<void>((resolve) => {
        execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => resolve())
      })
    } else {
      child.kill('SIGKILL')
    }
    if (!(await this.waitExit(10_000))) {
      child.kill('SIGKILL')
      await this.waitExit(5_000)
    }
  }
}

function quote(a: string): string {
  return /[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a
}
