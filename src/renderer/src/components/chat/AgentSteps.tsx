import {
  ChevronDown,
  FilePen,
  FilePlus,
  FileText,
  FolderTree,
  Loader2,
  Search,
  ShieldAlert,
  ShieldCheck,
  ShieldX,
  SquareTerminal,
  Wrench,
  type LucideIcon
} from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { AgentShell } from '@shared/config'
import type { AgentTurn, GuardVerdict, ToolCallRecord, ToolCallStatus } from '@shared/types'
import {
  diffLineKind,
  diffStat,
  formatDuration,
  isPathLike,
  previewLines,
  relativeTo,
  STATUS_LABEL,
  toolIntent,
  toolKind,
  toolSubject,
  toolVerb,
  truncateMiddle,
  type ToolKind
} from '@/lib/agent'
import { cn } from '@/lib/format'
import { friendlyError } from '@/lib/text'
import { useSettings } from '@/store/app'
import { useChat } from '@/store/chat'
import { Button } from '@/components/ui/Button'
import { Markdown } from './Markdown'
import { Reasoning } from './Reasoning'

const ICONS: Record<ToolKind, LucideIcon> = {
  read: FileText,
  list: FolderTree,
  search: Search,
  write: FilePlus,
  edit: FilePen,
  command: SquareTerminal,
  other: Wrench
}

const useShell = (): AgentShell => useSettings((s) => s.settings?.agent?.defaultShell ?? 'powershell')

// ---------- Вердикт охранника ----------

const VERDICT_TEXT: Record<GuardVerdict['level'], string> = { safe: 'безопасно', ask: 'спросить', block: 'опасно' }
const VERDICT_TONE: Record<GuardVerdict['level'], string> = {
  safe: 'text-ok',
  ask: 'text-warn',
  block: 'text-danger'
}
const VERDICT_ICON: Record<GuardVerdict['level'], LucideIcon> = { safe: ShieldCheck, ask: ShieldAlert, block: ShieldX }

export function verdictLabel(v: GuardVerdict): string {
  return `${v.by === 'rules' ? 'Правило' : 'Охранник'}: ${VERDICT_TEXT[v.level]}`
}

/** Бейдж вердикта. compact — в узкой карточке остаётся только значок (подпись во всплывающей подсказке). */
export function GuardBadge({ verdict, compact }: { verdict: GuardVerdict; compact?: boolean }): React.JSX.Element {
  const Icon = VERDICT_ICON[verdict.level]
  const label = verdictLabel(verdict)
  return (
    <span
      data-testid="guard-badge"
      title={verdict.reason ? `${label}. ${verdict.reason}` : label}
      className={cn('inline-flex shrink-0 items-center gap-1 text-[12px] whitespace-nowrap', VERDICT_TONE[verdict.level])}
    >
      <Icon size={13} aria-hidden />
      <span className={compact ? 'sr-only @xl:not-sr-only' : undefined}>{label}</span>
    </span>
  )
}

// ---------- Статус ----------

function StatusChip({ status }: { status: ToolCallStatus }): React.JSX.Element {
  const label = STATUS_LABEL[status]
  const spin = status === 'checking' || status === 'running'
  const tone =
    status === 'error'
      ? 'bg-danger/15 text-danger'
      : status === 'awaitingApproval'
        ? 'bg-warn/15 text-warn'
        : status === 'done' || status === 'pending'
          ? 'text-fg-faint'
          : 'bg-raised text-fg-muted'
  return (
    <span
      data-testid="tool-status"
      className={cn('inline-flex h-5 shrink-0 items-center gap-1 rounded px-1.5 text-[11.5px] whitespace-nowrap', tone)}
    >
      {spin && <Loader2 size={11} className="animate-spin" aria-hidden />}
      {label}
    </span>
  )
}

// ---------- Содержимое: diff и вывод ----------

const DIFF_LINE: Record<ReturnType<typeof diffLineKind>, string> = {
  add: 'bg-ok/12 text-ok',
  del: 'bg-danger/12 text-danger',
  hunk: 'text-info',
  meta: 'text-fg-faint',
  ctx: 'text-fg-muted'
}

export function DiffView({ diff, maxHeight = 'max-h-[320px]' }: { diff: string; maxHeight?: string }): React.JSX.Element {
  const lines = diff.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n')
  const { added, removed } = diffStat(diff)
  return (
    <div data-testid="diff-view" className="overflow-hidden rounded-[var(--radius-ctl)] border border-line bg-bg">
      <div className="tabular flex gap-2 border-b border-line px-2.5 py-1 text-[11.5px]">
        <span className="text-ok">+{added}</span>
        <span className="text-danger">−{removed}</span>
      </div>
      <div className={cn('overflow-auto py-1 font-mono text-[12px] leading-[1.55]', maxHeight)}>
        {lines.map((l, i) => (
          <div key={i} className={cn('min-w-fit px-2.5 whitespace-pre', DIFF_LINE[diffLineKind(l)])}>
            {l || ' '}
          </div>
        ))}
      </div>
    </div>
  )
}

function OutputView({
  text,
  maxLines,
  tone = 'normal',
  maxHeight = 'max-h-[280px]'
}: {
  text: string
  maxLines?: number
  tone?: 'normal' | 'danger'
  maxHeight?: string
}): React.JSX.Element {
  const p = maxLines ? previewLines(text, maxLines) : { text, more: 0 }
  return (
    <div className="overflow-hidden rounded-[var(--radius-ctl)] border border-line bg-bg">
      <pre
        className={cn(
          'overflow-auto px-2.5 py-1.5 font-mono text-[12px] leading-[1.55] whitespace-pre-wrap break-all',
          tone === 'danger' ? 'text-danger' : 'text-fg-muted',
          maxHeight
        )}
      >
        {p.text || ' '}
      </pre>
      {p.more > 0 && <div className="border-t border-line px-2.5 py-1 text-[11.5px] text-fg-faint">И ещё строк: {p.more}</div>}
    </div>
  )
}

function Label({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <div className="mb-1 text-[11.5px] text-fg-faint">{children}</div>
}

const APPROVED_BY: Record<NonNullable<ToolCallRecord['approvedBy']>, string> = {
  auto: 'Выполнено без вопроса',
  user: 'Разрешено вами',
  session: 'Разрешено для всего чата'
}

/** Что показать о действии: diff, команду, содержимое записи. Общая часть карточки и запроса подтверждения. */
function ActionPreview({ call, full }: { call: ToolCallRecord; full: boolean }): React.JSX.Element | null {
  const kind = toolKind(call.name)
  const content = typeof call.args.content === 'string' ? call.args.content : ''
  if (kind === 'write' || kind === 'edit') {
    if (call.diff) return <DiffView diff={call.diff} />
    if (content) return <OutputView text={content} maxLines={full ? undefined : 40} />
    return null
  }
  if (kind === 'command') {
    const command = toolSubject(call)
    // В заголовке карточки команда видна в одну строку — полностью показываем, только если она длиннее.
    if (!full && command.length < 70 && !command.includes('\n')) return null
    return (
      <pre className="overflow-auto rounded-[var(--radius-ctl)] border border-line bg-bg px-2.5 py-1.5 font-mono text-[12px] leading-[1.55] whitespace-pre-wrap break-all text-fg">
        {command}
      </pre>
    )
  }
  return null
}

function ToolDetails({ call }: { call: ToolCallRecord }): React.JSX.Element {
  const kind = toolKind(call.name)
  const cwd = typeof call.args.cwd === 'string' ? call.args.cwd : ''
  const preview = <ActionPreview call={call} full={false} />
  return (
    <div className="flex flex-col gap-2.5 border-t border-line px-2.5 py-2.5">
      {preview}
      {kind === 'command' && cwd && (
        <div className="text-[12px] text-fg-faint">
          Папка: <span className="font-mono text-fg-muted">{cwd}</span>
        </div>
      )}
      {call.result !== undefined && call.result !== '' && (
        <div>
          <Label>{kind === 'command' ? 'Вывод' : kind === 'write' || kind === 'edit' ? 'Ответ инструмента' : 'Результат'}</Label>
          <OutputView text={call.result} maxLines={kind === 'command' ? undefined : 40} />
        </div>
      )}
      {kind === 'command' && call.status === 'done' && !call.result && (
        <div className="text-[12px] text-fg-faint">Команда ничего не вывела.</div>
      )}
      {call.error && (
        <OutputView text={call.error} tone={call.status === 'denied' ? 'normal' : 'danger'} maxHeight="max-h-[160px]" />
      )}
      {(call.guard || call.approvedBy) && (
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-[12px]">
          {call.guard && <GuardBadge verdict={call.guard} />}
          {call.guard?.reason && <span className="min-w-0 text-fg-muted">{call.guard.reason}</span>}
          {call.approvedBy && <span className="text-fg-faint">{APPROVED_BY[call.approvedBy]}</span>}
        </div>
      )}
    </div>
  )
}

/** Главный аргумент в заголовке карточки. Путь усекается из середины: имя файла видно всегда. */
function Subject({ call, cwd }: { call: ToolCallRecord; cwd?: string }): React.JSX.Element {
  const subject = toolSubject(call)
  const kind = toolKind(call.name)
  const rel = kind === 'command' || kind === 'search' ? subject : relativeTo(subject, cwd)
  const cls = 'min-w-0 flex-1 font-mono text-[12px] text-fg'
  if (kind !== 'command' && kind !== 'search' && isPathLike(rel)) {
    const i = Math.max(rel.lastIndexOf('\\'), rel.lastIndexOf('/'))
    return (
      <span className={cn(cls, 'flex')} title={subject}>
        <span className="min-w-0 truncate">{rel.slice(0, i + 1)}</span>
        <span className="shrink-0">{truncateMiddle(rel.slice(i + 1), 48)}</span>
      </span>
    )
  }
  const lines = rel.split('\n')
  return (
    <span className={cn(cls, 'truncate')} title={subject}>
      {lines[0]}
      {lines.length > 1 && <span className="text-fg-faint"> …</span>}
    </span>
  )
}

// ---------- Карточка инструмента ----------

export function ToolCard({ call, cwd }: { call: ToolCallRecord; cwd?: string }): React.JSX.Element {
  const shell = useShell()
  const [open, setOpen] = useState(false)
  const kind = toolKind(call.name)
  const Icon = ICONS[kind]
  const failed = call.exitCode !== undefined && call.exitCode !== 0
  return (
    <div
      data-testid="tool-card"
      data-status={call.status}
      className={cn(
        '@container overflow-hidden rounded-[var(--radius-ctl)] border bg-panel',
        call.status === 'error' ? 'border-danger/35' : 'border-line'
      )}
    >
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="flex h-8 w-full min-w-0 items-center gap-2 px-2.5 text-left text-[12.5px] hover:bg-panel-2"
      >
        <Icon size={14} className="shrink-0 text-fg-faint" aria-hidden />
        <span className="shrink-0 text-fg-muted">{toolVerb(call, shell)}</span>
        <Subject call={call} cwd={cwd} />
        {call.guard && <GuardBadge verdict={call.guard} compact />}
        {call.exitCode !== undefined && (
          <span className={cn('tabular shrink-0 text-[11.5px]', failed ? 'text-danger' : 'text-fg-faint')} title="Код выхода">
            код {call.exitCode}
          </span>
        )}
        {call.durationMs !== undefined && (
          <span className="tabular shrink-0 text-[11.5px] text-fg-faint">{formatDuration(call.durationMs)}</span>
        )}
        <StatusChip status={call.status} />
        <ChevronDown size={13} className={cn('shrink-0 text-fg-faint transition-transform', open && 'rotate-180')} aria-hidden />
      </button>
      {!open && call.error && (
        <div
          className={cn(
            'line-clamp-2 border-t border-line px-2.5 py-1.5 text-[12px]',
            call.status === 'denied' ? 'text-fg-muted' : 'text-danger'
          )}
        >
          {call.error}
        </div>
      )}
      {open && <ToolDetails call={call} />}
    </div>
  )
}

// ---------- Запрос подтверждения ----------

export function ApprovalCard({ call, cwd }: { call: ToolCallRecord; cwd?: string }): React.JSX.Element {
  const shell = useShell()
  const approve = useChat((s) => s.approve)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const ref = useRef<HTMLDivElement>(null)
  const shownAt = useRef(0)
  const kind = toolKind(call.name)
  const subject = toolSubject(call)
  const intent = toolIntent(call, shell)

  useEffect(() => {
    shownAt.current = Date.now()
    const el = ref.current
    if (!el) return
    el.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    // Фокус забираем, только если он никому не нужен: иначе Enter, набранный в поле ввода, разрешил бы действие.
    const active = document.activeElement
    if (!active || active === document.body) el.focus({ preventScroll: true })
  }, [call.id])

  const decide = (decision: 'allow' | 'deny' | 'allowAll'): void => {
    if (busy) return
    setBusy(true)
    setError(null)
    approve(call.id, decision).then(
      // Обычно карточка сменится на обычную со следующим снимком шагов. Если снимок не пришёл — кнопки снова доступны.
      () => setTimeout(() => setBusy(false), 4000),
      (e: unknown) => {
        setError(`Не удалось передать решение: ${friendlyError(e)}`)
        setBusy(false)
      }
    )
  }

  const dangerous = call.guard?.level === 'block'
  return (
    <div
      ref={ref}
      id={`approval-${call.id}`}
      data-testid="approval-card"
      role="group"
      aria-label={intent}
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget || e.nativeEvent.isComposing) return
        // Защита от залипшей клавиши: решение не принимается в первые мгновения после появления.
        if (Date.now() - shownAt.current < 400) return
        if (e.key === 'Enter') {
          e.preventDefault()
          // Enter — главное действие кнопок: при вердикте «опасно» это «Запретить».
          decide(dangerous ? 'deny' : 'allow')
        } else if (e.key === 'Escape') {
          e.preventDefault()
          e.stopPropagation()
          decide('deny')
        }
      }}
      className="group/approval flex scroll-my-6 flex-col gap-2.5 rounded-[var(--radius-panel)] border border-warn/50 bg-panel p-3 outline-offset-2"
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <ShieldAlert size={15} className="shrink-0 text-warn" aria-hidden />
        <span className="min-w-0 flex-1 text-[13.5px] font-medium text-fg">{intent}</span>
        <StatusChip status={call.status} />
      </div>
      {kind !== 'command' && subject && (
        <div className="font-mono text-[12.5px] break-all text-fg" title={subject}>
          {relativeTo(subject, cwd)}
        </div>
      )}
      <ActionPreview call={call} full />
      {call.guard && (
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-[12.5px]">
          <GuardBadge verdict={call.guard} />
          {call.guard.reason && <span className="min-w-0 text-fg-muted">{call.guard.reason}</span>}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2 pt-0.5">
        {dangerous ? (
          <>
            <Button size="sm" variant="primary" disabled={busy} onClick={() => decide('deny')}>
              Запретить
            </Button>
            <Button size="sm" variant="danger" disabled={busy} onClick={() => decide('allow')}>
              Всё равно разрешить
            </Button>
          </>
        ) : (
          <>
            <Button size="sm" variant="primary" disabled={busy} onClick={() => decide('allow')}>
              Разрешить
            </Button>
            <Button size="sm" disabled={busy} onClick={() => decide('deny')}>
              Запретить
            </Button>
          </>
        )}
        <Button
          size="sm"
          variant="ghost"
          disabled={busy}
          onClick={() => decide('allowAll')}
          title="Агент перестанет спрашивать в этом чате. Действия, опасные по жёстким правилам, всё равно придут на подтверждение."
        >
          Разрешать всё в этом чате
        </Button>
        <span className="ml-auto hidden text-[11.5px] text-fg-faint group-focus/approval:inline">
          Enter — разрешить, Esc — запретить
        </span>
      </div>
      <p className="text-[11.5px] leading-snug text-fg-faint">
        «Разрешать всё» действует только в этом чате; об опасном по жёстким правилам агент спросит всё равно.
      </p>
      {error && <p className="text-[12.5px] text-danger">{error}</p>}
    </div>
  )
}

// ---------- Шаги агента ----------

function Thinking({ first }: { first: boolean }): React.JSX.Element {
  return (
    <div className="flex items-center gap-2 py-1 text-[13px] text-fg-faint">
      <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-accent" />
      {first ? 'Обрабатываю промпт…' : 'Агент думает над следующим шагом…'}
    </div>
  )
}

function TurnView({ turn, live, cwd }: { turn: AgentTurn; live: boolean; cwd?: string }): React.JSX.Element | null {
  if (!turn.content && !turn.reasoning && !turn.toolCalls.length) return null
  return (
    <div data-testid="agent-turn" className="flex flex-col">
      {turn.reasoning ? <Reasoning text={turn.reasoning} live={live && !turn.content && !turn.toolCalls.length} /> : null}
      {turn.content ? <Markdown text={turn.content} /> : null}
      {turn.toolCalls.length > 0 && (
        <div className={cn('flex flex-col gap-1.5', turn.content && 'mt-2.5')}>
          {turn.toolCalls.map((c) =>
            c.status === 'awaitingApproval' ? <ApprovalCard key={c.id} call={c} cwd={cwd} /> : <ToolCard key={c.id} call={c} cwd={cwd} />
          )}
        </div>
      )}
    </div>
  )
}

/** Ответ агента: шаги по порядку — рассуждения, текст, вызовы инструментов. */
export function AgentTurns({
  turns,
  content,
  streaming,
  cwd
}: {
  turns: AgentTurn[]
  /** Текст последнего шага из версии сообщения (если main не положил его в шаги). */
  content: string
  streaming: boolean
  cwd?: string
}): React.JSX.Element {
  const last = turns[turns.length - 1]
  const trailing = !streaming && content && content !== (last?.content ?? '') ? content : ''
  // Ждём модель: шаг ещё пуст или все его инструменты отработали, а следующий шаг не начался.
  const idleStep =
    !last ||
    (!last.content && !last.reasoning && !last.toolCalls.length) ||
    (last.toolCalls.length > 0 && last.toolCalls.every((c) => c.status === 'done' || c.status === 'error' || c.status === 'denied'))
  const hasAny = turns.some((t) => t.content || t.reasoning || t.toolCalls.length)
  return (
    <div className="flex flex-col gap-3.5">
      {turns.map((t, i) => (
        <TurnView key={i} turn={t} live={streaming && i === turns.length - 1} cwd={cwd} />
      ))}
      {trailing && <Markdown text={trailing} />}
      {streaming && idleStep && <Thinking first={!hasAny} />}
    </div>
  )
}
