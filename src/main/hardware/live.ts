// Живой мониторинг VRAM/RAM: один постоянный процесс `nvidia-smi -lms 1000`. Без electron.
import { spawn, type ChildProcess } from 'node:child_process'
import type { HardwareLive } from '@shared/types'
import { nvidiaSmiPath, ramInfo } from './detect'

export interface GpuSample {
  usedMiB: number
  totalMiB: number
  util: number
}

/** Строка `memory.used, memory.total, utilization.gpu` → замер (или null). */
export function parseLiveLine(line: string): GpuSample | null {
  const cols = line.split(',').map((c) => Number(c.trim()))
  if (cols.length < 3 || cols.slice(0, 2).some((n) => !Number.isFinite(n))) return null
  const [used, total, util] = cols as [number, number, number]
  return { usedMiB: used, totalMiB: total, util: Number.isFinite(util) ? util : 0 }
}

/** Суммирует замеры по всем GPU одного тика. */
export function aggregateLive(samples: GpuSample[]): HardwareLive {
  const ram = ramInfo()
  return {
    vramUsedMiB: samples.reduce((s, g) => s + g.usedMiB, 0),
    vramTotalMiB: samples.reduce((s, g) => s + g.totalMiB, 0),
    gpuUtil: samples.length ? Math.max(...samples.map((g) => g.util)) : 0,
    ramUsedMiB: ram.ramTotalMiB - ram.ramFreeMiB,
    ramTotalMiB: ram.ramTotalMiB
  }
}

export class LivePoller {
  private child: ChildProcess | null = null
  private timer: NodeJS.Timeout | null = null
  private restartTimer: NodeJS.Timeout | null = null
  private flushTimer: NodeJS.Timeout | null = null
  private stopped = true
  private buf = ''
  private tick: GpuSample[] = []
  private failures = 0

  constructor(
    private readonly gpuCount: number,
    private readonly onSample: (s: HardwareLive) => void,
    private readonly intervalMs = 1000
  ) {}

  start(): void {
    if (!this.stopped) return
    this.stopped = false
    if (this.gpuCount > 0) this.spawnSmi()
    else this.timer = setInterval(() => this.onSample(aggregateLive([])), this.intervalMs)
  }

  stop(): void {
    this.stopped = true
    if (this.timer) clearInterval(this.timer)
    if (this.restartTimer) clearTimeout(this.restartTimer)
    if (this.flushTimer) clearTimeout(this.flushTimer)
    this.timer = this.restartTimer = this.flushTimer = null
    const c = this.child
    this.child = null
    if (c && c.exitCode === null) c.kill()
  }

  private spawnSmi(): void {
    const smi = nvidiaSmiPath()
    if (!smi) return
    const child = spawn(
      smi,
      [
        '--query-gpu=memory.used,memory.total,utilization.gpu',
        '--format=csv,noheader,nounits',
        `-lms`,
        String(this.intervalMs)
      ],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }
    )
    this.child = child
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (d: string) => this.onData(d))
    const restart = (): void => {
      if (this.child !== child) return
      this.child = null
      if (this.stopped) return
      // Перезапуск с нарастающей паузой; если nvidia-smi пропал — хотя бы RAM.
      this.failures++
      this.onSample(aggregateLive([]))
      this.restartTimer = setTimeout(() => this.spawnSmi(), Math.min(1000 * this.failures, 30000))
    }
    child.on('exit', restart)
    child.on('error', restart)
  }

  private onData(d: string): void {
    this.buf += d
    let nl: number
    while ((nl = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, nl)
      this.buf = this.buf.slice(nl + 1)
      const s = parseLiveLine(line)
      if (!s) continue
      this.failures = 0
      this.tick.push(s)
      if (this.tick.length >= this.gpuCount) this.flush()
      else if (!this.flushTimer) this.flushTimer = setTimeout(() => this.flush(), 200)
    }
  }

  private flush(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer)
    this.flushTimer = null
    if (!this.tick.length) return
    const samples = this.tick
    this.tick = []
    this.onSample(aggregateLive(samples))
  }
}
