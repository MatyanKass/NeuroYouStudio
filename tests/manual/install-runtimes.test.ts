// Реальная установка сборок через RuntimeStore. Запуск: NYS_E2E=1 npx vitest run tests/manual/install-runtimes.test.ts
// Ставит в настоящую папку приложения (%LOCALAPPDATA%\NeuroYouStudio\runtimes), чтобы потом их использовало приложение.
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { RuntimeStore } from '../../src/main/runtimes/store'

const E2E = process.env.NYS_E2E === '1'
const local = join(process.env.LOCALAPPDATA ?? '', 'NeuroYouStudio')
const ids = (process.env.NYS_RUNTIMES ?? 'llamacpp-b11538-cuda12.4,ikllama-b5418-cuda12.8-avx2').split(',')

describe.skipIf(!E2E)('установка сборок (e2e)', () => {
  const store = new RuntimeStore({ runtimesDir: join(local, 'runtimes'), tmpDir: join(local, 'tmp') })
  for (const id of ids) {
    it(`install ${id}`, async () => {
      let last = 0
      await store.install(id, (p) => {
        const pct = p.totalBytes ? Math.floor((p.receivedBytes / p.totalBytes) * 100) : 0
        if (pct >= last + 10 || p.done || p.phase !== 'Загрузка') {
          last = pct
          console.log(`[${id}] ${p.phase} ${pct}%${p.done ? ' done' : ''}`)
        }
      })
      expect(await store.marker(id)).not.toBeNull()
    }, 3_600_000)
  }
})
