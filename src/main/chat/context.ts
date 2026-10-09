import type { ContextOverflowPolicy } from '@shared/config'

export interface CountedMessage {
  role: 'user' | 'assistant' | 'system'
  tokens: number
}

/**
 * Какие сообщения истории оставить, чтобы промпт влез в бюджет токенов.
 * История делится на «ходы» (реплика пользователя + ответы на неё) и выбрасывается целыми ходами,
 * чтобы роли продолжали чередоваться (иначе шаблоны Gemma/Mistral падают). Последний ход не трогаем.
 */
export function fitHistory(
  messages: CountedMessage[],
  systemTokens: number,
  budget: number,
  policy: ContextOverflowPolicy
): { keep: number[]; dropped: number } {
  const sum = (idx: number[]): number => systemTokens + idx.reduce((s, i) => s + (messages[i]?.tokens ?? 0), 0)
  const all = messages.map((_, i) => i)
  if (sum(all) <= budget) return { keep: all, dropped: 0 }
  if (policy === 'stopAtLimit') {
    throw new Error(
      `Диалог не помещается в контекст (${sum(all)} из ${budget} токенов). Увеличьте длину контекста или выберите другую политику переполнения.`
    )
  }

  // Ходы: каждый начинается с реплики пользователя.
  const turns: number[][] = []
  for (let i = 0; i < messages.length; i++) {
    if (messages[i]!.role === 'user' || turns.length === 0) turns.push([i])
    else turns[turns.length - 1]!.push(i)
  }
  const lastTurn = turns.length - 1
  const candidates = turns.map((_, t) => t).filter((t) => t !== lastTurn)
  // «Обрезка середины» держит первый ход до последнего.
  const order = policy === 'truncateMiddle' && candidates.length > 1 ? [...candidates.slice(1), candidates[0]!] : candidates

  const droppedTurns = new Set<number>()
  const keepOf = (): number[] => turns.flatMap((t, ti) => (droppedTurns.has(ti) ? [] : t))
  for (const t of order) {
    if (sum(keepOf()) <= budget) break
    droppedTurns.add(t)
  }
  const keep = keepOf()
  if (sum(keep) > budget) {
    throw new Error(
      `Сообщение не помещается в контекст (${sum(keep)} из ${budget} токенов). Увеличьте длину контекста или сократите сообщение.`
    )
  }
  return { keep, dropped: messages.length - keep.length }
}
