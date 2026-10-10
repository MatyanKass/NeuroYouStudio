// Сквозной прогон агента на реальной модели через менеджер движков (electron подменён).
// Запуск: NYS_E2E_AGENT=1 npx vitest run tests/agent/e2e.test.ts
import { afterAll, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { DEFAULT_LOAD_CONFIG, DEFAULT_PREDICTION_CONFIG, deepMerge } from '@shared/config'
import type { ChatMessage, Conversation } from '@shared/types'

const h = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require('node:fs') as typeof import('node:fs')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const os = require('node:os') as typeof import('node:os')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const path = require('node:path') as typeof import('node:path')
  return { userData: fs.mkdtempSync(path.join(os.tmpdir(), 'nys-agent-e2e-')), home: os.homedir() }
})

vi.mock('electron', () => ({
  app: { getPath: (n: string) => (n === 'home' ? h.home : h.userData), getVersion: () => '0.0.0', isPackaged: false },
  ipcMain: { handle: () => undefined },
  BrowserWindow: {
    getAllWindows: () => [{ isDestroyed: () => false, webContents: { send: () => undefined } }]
  },
  safeStorage: { isEncryptionAvailable: () => false, encryptString: (s: string) => Buffer.from(s), decryptString: (b: Buffer) => b.toString() }
}))

const E2E = process.env.NYS_E2E_AGENT === '1'

describe.skipIf(!E2E)('агент на реальной модели (e2e)', async () => {
  const { listModels } = await import('../../src/main/models/registry')
  const mgr = await import('../../src/main/engines/manager')
  const { loadSettings, updateSettings } = await import('../../src/main/settings')
  const { runAgentStream } = await import('../../src/main/agent/loop')
  const { evaluateAction } = await import('../../src/main/agent/policy')
  const { createConversation, getConversation, saveConversation } = await import('../../src/main/chat/store')

  afterAll(async () => {
    await mgr.shutdownEngines()
    rmSync(h.userData, { recursive: true, force: true })
  })

  it('политика: удаление C:\\Windows блокируется, python hello.py безопасен', async () => {
    const block = await evaluateAction({
      tool: 'run_command',
      args: { command: 'Remove-Item -Recurse -Force C:\\Windows' },
      cwd: 'C:\\tmp',
      userRequest: 'почисти',
      guardEnabled: false
    })
    expect(block.level).toBe('block')
    const safe = await evaluateAction({
      tool: 'run_command',
      args: { command: 'python hello.py' },
      cwd: 'C:\\tmp',
      userRequest: 'запусти',
      guardEnabled: false
    })
    expect(safe.level).toBe('safe')
  })

  it('создаёт hello.py и запускает его, вывод содержит «Привет»', async () => {
    await loadSettings()
    await updateSettings({ agent: { approval: 'auto', guardEnabled: false, maxSteps: 8, defaultShell: 'powershell' } })
    const models = await listModels(true)
    const m = models.find((x) => x.path.endsWith('Qwen3-0.6B-Q8_0.gguf'))
    expect(m, 'нужна Qwen3-0.6B-Q8_0.gguf').toBeDefined()
    const st = await mgr.loadModel(m!.id, deepMerge(DEFAULT_LOAD_CONFIG, { contextLength: 4096 }))
    expect(st.state).toBe('ready')

    const cwd = mkdtempSync(join(h.userData, 'agent-cwd-'))
    const prediction = deepMerge(DEFAULT_PREDICTION_CONFIG, {
      temperature: 0.2,
      reasoning: { enableThinking: false }
    })
    const prompt =
      'Выполни два шага. 1) Вызови инструмент write_file с аргументами path="hello.py" и content="print(\'Привет\')". ' +
      '2) Затем вызови run_command с аргументом command="python hello.py". Путь к файлу — ровно hello.py.'

    // 0.6B-модель слабая и нестабильная — даём несколько попыток доказать сквозную работу связки.
    const helloPath = join(cwd, 'hello.py')
    let ran = false
    for (let attempt = 1; attempt <= 3 && !ran; attempt++) {
      rmSync(helloPath, { force: true })
      const conv: Conversation = await createConversation()
      const user: ChatMessage = { id: 'u1', role: 'user', versions: [{ content: prompt, createdAt: 1 }], activeVersion: 0 }
      const target: ChatMessage = { id: 'a1', role: 'assistant', versions: [{ content: '', createdAt: 2 }], activeVersion: 0 }
      conv.messages = [user, target]
      conv.agent = { enabled: true, cwd, allowAll: false }
      await saveConversation(conv)

      await runAgentStream({
        convId: conv.id,
        target,
        history: [user],
        eng: mgr.activeEngine()!,
        prediction,
        version: target.versions[0]!,
        versionIndex: 0,
        controller: new AbortController(),
        cwd,
        allowAll: false
      })

      const v = (await getConversation(conv.id))!.messages[1]!.versions[0]!
      const calls = (v.turns ?? []).flatMap((t) => t.toolCalls)
      console.log(`[e2e] попытка ${attempt}: шагов`, v.turns?.length, 'вызовов:', calls.map((c) => `${c.name}:${c.status}`).join(', '))
      for (const c of calls) console.log(`[e2e]   ${c.name}(${JSON.stringify(c.args)}) →`, (c.result ?? c.error ?? '').slice(0, 160))
      ran = existsSync(helloPath) && calls.some((c) => c.name === 'run_command' && (c.result ?? '').includes('Привет'))
    }

    expect(existsSync(helloPath), 'hello.py должен существовать').toBe(true)
    console.log('[e2e] hello.py:', readFileSync(helloPath, 'utf8'))
    expect(ran, 'вывод run_command должен содержать «Привет»').toBe(true)
    rmSync(cwd, { recursive: true, force: true })
  }, 600_000)
})
