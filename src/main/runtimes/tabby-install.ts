// Установка ExLlamaV3 через TabbyAPI: uv → Python 3.12 → venv → TabbyAPI[cu12] (torch cu128 + exllamav3).
// Без electron — пути и прогресс передаются параметрами.
import { spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { downloadFile } from './download'
import { extractZipFlatten } from './store'

// 0.13.0 ломает `python install` на Windows (ошибка minor version link) — держим 0.12.x.
export const UV_VERSION = '0.12.19'
export const UV_ZIP = {
  url: `https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/uv-x86_64-pc-windows-msvc.zip`,
  size: 17955780,
  sha256: '6dbb02d79e419522f1c500f0adb1cddcff0cda7d59b0d66ea7f5e3b4a1b2f5f0'
}
export const TABBY_COMMIT = '884e88cc1fdd2dfcd5ed27f71ff5b41f52541e1f'
export const TABBY_ZIP_URL = `https://github.com/theroyallab/tabbyAPI/archive/${TABBY_COMMIT}.zip`
export const PYTHON_VERSION = '3.12'
/** torch 2.9.0+cu128 и exllamav3 1.6.0 cu128 — сборки с нативным кодом для sm_75…sm_120. */
export const TABBY_EXTRA = 'cu12'

export interface TabbyPaths {
  dir: string
  uvExe: string
  pythonDir: string
  venvDir: string
  venvPython: string
  tabbyDir: string
}

export function tabbyPaths(dir: string): TabbyPaths {
  return {
    dir,
    uvExe: join(dir, 'uv', 'uv.exe'),
    pythonDir: join(dir, 'python'),
    venvDir: join(dir, 'venv'),
    venvPython: join(dir, 'venv', 'Scripts', 'python.exe'),
    tabbyDir: join(dir, 'tabbyAPI')
  }
}

export interface InstallStep {
  phase: string
  /** 0..1 — общая доля выполненной установки. */
  fraction: number
}

/** Окружение для uv: только свой Python, свои кэши, без пользовательских конфигов. */
function uvEnv(p: TabbyPaths, cacheDir: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    UV_PYTHON_INSTALL_DIR: p.pythonDir,
    UV_PYTHON_PREFERENCE: 'only-managed',
    UV_CACHE_DIR: cacheDir,
    UV_NO_CONFIG: '1',
    UV_LINK_MODE: 'copy',
    UV_HTTP_TIMEOUT: '120',
    UV_HTTP_RETRIES: '5',
    VIRTUAL_ENV: '',
    PYTHONUTF8: '1'
  }
}

// Escape-последовательности цвета/курсора в выводе uv.
const ANSI_RE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*[A-Za-z]`, 'g')

function runUv(
  exe: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  cwd: string,
  onLine: (line: string) => void,
  signal?: AbortSignal
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, { env, cwd, windowsHide: true })
    const tail: string[] = []
    const feed = (buf: Buffer): void => {
      for (const raw of buf.toString('utf8').split(/\r?\n|\r/)) {
        const line = raw.replace(ANSI_RE, '').trim()
        if (!line) continue
        tail.push(line)
        if (tail.length > 40) tail.shift()
        onLine(line)
      }
    }
    child.stdout.on('data', feed)
    child.stderr.on('data', feed)
    const onAbort = (): void => {
      child.kill()
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    child.on('error', (e) => reject(e))
    child.on('close', (code) => {
      signal?.removeEventListener('abort', onAbort)
      if (signal?.aborted) reject(new Error('Установка отменена'))
      else if (code === 0) resolve()
      else reject(new Error(`uv ${args[0]} завершился с кодом ${code}:\n${tail.slice(-12).join('\n')}`))
    })
  })
}

/**
 * Полная установка в dir. Шаги идемпотентны: повторный запуск докачивает и доустанавливает.
 * Объём: ~3,5 ГБ загрузки (torch с CUDA — основная часть), ~6 ГБ на диске.
 */
export async function installTabby(
  dir: string,
  tmpDir: string,
  onStep: (s: InstallStep) => void,
  signal?: AbortSignal
): Promise<void> {
  const p = tabbyPaths(dir)
  await fs.mkdir(dir, { recursive: true })
  await fs.mkdir(tmpDir, { recursive: true })
  const cacheDir = join(tmpDir, 'uv-cache')
  const env = uvEnv(p, cacheDir)

  onStep({ phase: 'Загрузка uv', fraction: 0.01 })
  const uvZip = join(tmpDir, `uv-${UV_VERSION}.zip`)
  await downloadFile({ url: UV_ZIP.url, dest: uvZip, sha256: UV_ZIP.sha256, size: UV_ZIP.size, signal })
  await extractZipFlatten(uvZip, join(dir, 'uv'))

  onStep({ phase: 'Загрузка TabbyAPI', fraction: 0.03 })
  const tabbyZip = join(tmpDir, `tabbyAPI-${TABBY_COMMIT.slice(0, 12)}.zip`)
  await downloadFile({ url: TABBY_ZIP_URL, dest: tabbyZip, signal })
  await fs.rm(p.tabbyDir, { recursive: true, force: true })
  await extractZipFlatten(tabbyZip, p.tabbyDir)

  onStep({ phase: `Установка Python ${PYTHON_VERSION}`, fraction: 0.06 })
  // --no-bin/--no-registry: не трогаем ~/.local/bin и реестр Windows — Python только для приложения.
  await runUv(p.uvExe, ['python', 'install', PYTHON_VERSION, '--no-bin', '--no-registry'], env, dir, () => undefined, signal)

  onStep({ phase: 'Создание окружения Python', fraction: 0.1 })
  await runUv(p.uvExe, ['venv', p.venvDir, '--python', PYTHON_VERSION, '--allow-existing'], env, dir, () => undefined, signal)

  // Самый долгий шаг: torch (~2,5 ГБ), exllamav3, triton-windows и зависимости TabbyAPI.
  let fraction = 0.12
  onStep({ phase: 'Загрузка PyTorch и ExLlamaV3 (несколько гигабайт)', fraction })
  await runUv(
    p.uvExe,
    ['pip', 'install', '--python', p.venvPython, `${p.tabbyDir}[${TABBY_EXTRA}]`],
    env,
    dir,
    (line) => {
      // uv печатает «Downloading torch (2.4GiB)», «Prepared N packages», «Installed N packages».
      let phase: string | null = null
      if (/^Resolved \d+ packages/.test(line)) {
        fraction = Math.max(fraction, 0.2)
        phase = 'Зависимости определены, загрузка пакетов'
      } else if (/^Downloading (\S+)/.test(line)) {
        fraction = Math.min(0.85, fraction + 0.03)
        phase = `Загрузка: ${line.replace(/^Downloading /, '')}`
      } else if (/^Prepared \d+ packages/.test(line)) {
        fraction = 0.9
        phase = 'Распаковка пакетов'
      } else if (/^Installed \d+ packages/.test(line)) {
        fraction = 0.97
        phase = 'Пакеты установлены'
      }
      if (phase) onStep({ phase, fraction })
    },
    signal
  )

  onStep({ phase: 'Очистка кэша загрузок', fraction: 0.98 })
  await fs.rm(cacheDir, { recursive: true, force: true }).catch(() => undefined)
  await fs.rm(uvZip, { force: true }).catch(() => undefined)
  await fs.rm(tabbyZip, { force: true }).catch(() => undefined)
}

/** Проверка, что окружение собрано: есть python в venv и main.py TabbyAPI. */
export async function tabbyInstalled(dir: string): Promise<boolean> {
  const p = tabbyPaths(dir)
  try {
    await fs.access(p.venvPython)
    await fs.access(join(p.tabbyDir, 'main.py'))
    return true
  } catch {
    return false
  }
}
