// Реальная установка ExLlamaV3/TabbyAPI (несколько гигабайт). Запуск: NYS_E2E_TABBY=1 npx vitest run tests/runtimes/tabby-install.e2e.test.ts
import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { installTabby, tabbyInstalled } from '../../src/main/runtimes/tabby-install'

const local = process.env.LOCALAPPDATA ?? ''
const dir = join(local, 'NeuroYouStudio', 'runtimes', 'exl3-tabbyapi-884e88c-cu128')
const tmp = join(local, 'NeuroYouStudio', 'tmp')

describe.skipIf(!process.env.NYS_E2E_TABBY)('установка TabbyAPI', () => {
  it(
    'ставит uv, Python, venv и TabbyAPI[cu12]',
    async () => {
      await installTabby(dir, tmp, (s) => console.log(`[${Math.round(s.fraction * 100)}%] ${s.phase}`))
      expect(await tabbyInstalled(dir)).toBe(true)
    },
    60 * 60_000
  )
})
