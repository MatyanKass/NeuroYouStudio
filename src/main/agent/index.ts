// Регистрация IPC агента и фоновая логика: подтверждения, статус охранника, загрузка модели-охранника.
import { app } from 'electron'
import type { ModelFormat } from '@shared/config'
import { handle } from '../ipc'
import { getSettings, updateSettings } from '../settings'
import { addModelsListener } from '../models/registry'
import { downloadModelFile } from '../hf'
import { resolveApproval } from './loop'
import { GUARD_MODEL, autoSelectGuardModel, guardStatus, setGuardDownloadId, stopGuard } from './guard'

export { runAgentStream, type AgentRunContext } from './loop'

let unsubscribe: (() => void) | null = null

/** Выбрать рекомендованную модель-охранник, если она есть локально, а в настройках не выбрана. */
async function maybeAutoSelectGuard(): Promise<void> {
  if (getSettings().agent.guardModelId) {
    setGuardDownloadId(undefined)
    return
  }
  const id = await autoSelectGuardModel()
  if (id && !getSettings().agent.guardModelId) {
    await updateSettings({ agent: { guardModelId: id } })
    setGuardDownloadId(undefined)
  }
}

export function registerAgentIpc(): void {
  handle('agent:approve', (conversationId, toolCallId, decision) => {
    resolveApproval(conversationId, toolCallId, decision)
  })
  handle('agent:guardStatus', () => guardStatus())
  handle('agent:defaultCwd', () => app.getPath('home'))
  handle('agent:downloadGuard', async () => {
    const id = await downloadModelFile(GUARD_MODEL.repo, 'gguf' satisfies ModelFormat, GUARD_MODEL.file)
    setGuardDownloadId(id)
  })

  // Когда модель-охранник докачается, список моделей обновится — выберем её автоматически.
  unsubscribe = addModelsListener(() => void maybeAutoSelectGuard())
  void maybeAutoSelectGuard()
}

export async function shutdownAgent(): Promise<void> {
  unsubscribe?.()
  unsubscribe = null
  await stopGuard()
}
