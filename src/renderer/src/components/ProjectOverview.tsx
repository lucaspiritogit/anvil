import type { JSX } from 'react'
import { useEffect, useMemo, useState } from 'react'
import { formatCost, formatDuration, formatTokens } from '../format'
import { useStore } from '../state/store'
import { btn, card, cn, deliveryTone, dot, statusTone } from '../ui'
import type { Project, Run } from '@shared/types'

interface Props {
  project: Project
  runs: Run[]
  onOpenRun: (runId: string) => void
  onStartTask: () => void
  onOpenSettings: () => void
}

const SPREAD = 'max-w-[1100px] mx-auto'
const SECTION_HEAD = 'flex gap-4 items-center justify-between mb-4'
const SECTION_TITLE = 'mb-1 text-sm font-semibold'
const SECTION_NOTE = 'text-xs text-dim'
const TASK_LIST = 'flex flex-col gap-1.5'
const LIST_EMPTY = 'px-2.5 py-[22px] text-xs text-dim text-center'

function UsageMeter({
  label,
  value,
  limit,
  formattedValue,
  formattedLimit
}: {
  label: string
  value: number
  limit: number | null
  formattedValue: string
  formattedLimit: string
}): JSX.Element {
  const percent = limit ? Math.min(100, (value / limit) * 100) : 0
  return (
    <div>
      <div className="flex justify-between mb-2 text-xs">
        <span>{label}</span>
        <span className="text-dim">
          {limit ? `${formattedValue} of ${formattedLimit}` : `${formattedValue} used`}
        </span>
      </div>
      <div
        className={cn(
          'h-1.5 overflow-hidden bg-canvas rounded-full',
          !limit && 'opacity-55'
        )}
      >
        <span
          className={cn(
            'block h-full rounded-[inherit]',
            limit && value >= limit ? 'bg-danger' : 'bg-accent'
          )}
          style={{ width: `${percent}%` }}
        />
      </div>
      {!limit && <span className="block mt-1.5 text-[10px] text-dim">No monthly limit set</span>}
    </div>
  )
}

function TaskCard({ run, now, onOpen }: { run: Run; now: number; onOpen: () => void }): JSX.Element {
  const executionLabel =
    run.status === 'running'
      ? 'Working'
      : run.status === 'succeeded'
        ? 'Succeeded'
        : run.status === 'failed'
          ? 'Failed'
          : 'Cancelled'
  const codeLabel =
    run.deliveryStatus === 'approved'
      ? 'Approved'
      : run.deliveryStatus === 'reviewable'
        ? 'Reviewable'
        : run.deliveryStatus === 'did_not_commit'
          ? 'Finisher committing'
          : run.deliveryStatus === 'no_changes'
            ? 'No changes'
            : run.deliveryStatus === 'unavailable'
              ? 'Not tracked by Git'
              : run.deliveryStatus === 'finalizing'
                ? 'Saving branch'
                : run.deliveryStatus === 'failed'
                  ? 'Delivery failed'
                  : run.deliveryStatus === 'agent_failed'
                    ? 'Not reviewable'
                    : null
  return (
    <button
      className="flex gap-2.5 items-center w-full p-2.5 text-left bg-canvas border border-line rounded-md hover:bg-hover"
      onClick={onOpen}
    >
      <span className={dot(run.status)} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-xs">{run.title}</span>
        <span className="block truncate mt-[3px] text-[10px] text-dim">
          {run.agentLabel} · {formatTokens(run.totalTokens)} tokens · {formatDuration(run, now)}
        </span>
      </span>
      <span className="flex flex-none flex-col gap-1.5 items-end">
        <span className={cn('text-[10px]', statusTone(run.status))}>{executionLabel}</span>
        {codeLabel && (
          <span className={cn('text-[10px]', deliveryTone(run.deliveryStatus))}>{codeLabel}</span>
        )}
      </span>
    </button>
  )
}

function GitAlert({ project }: { project: Project }): JSX.Element | null {
  const status = useStore((s) => s.gitStatusByProject[project.id])
  const pending = useStore((s) => s.gitInitPending === project.id)
  const error = useStore((s) => s.gitInitError)
  const loadGitStatus = useStore((s) => s.loadGitStatus)
  const initGitRepo = useStore((s) => s.initGitRepo)

  useEffect(() => {
    void loadGitStatus(project.id)
  }, [loadGitStatus, project.id])

  if (!status || status.isRepository) return null

  const canInit = status.pathExists && status.gitAvailable
  const detail = !status.pathExists
    ? 'The project folder no longer exists at this path.'
    : status.gitAvailable
      ? 'Agents will run directly in the project folder. Branches, worktrees and reviewable diffs are skipped.'
      : 'Git could not be run on this machine, so branches, worktrees and reviewable diffs are skipped.'

  return (
    <div
      className={cn(
        SPREAD,
        'flex gap-4 items-center justify-between px-[18px] py-3.5 mb-4',
        'text-warn bg-warn/8 border border-warn/35 rounded-card'
      )}
      role="status"
    >
      <div className="flex flex-col gap-[3px]">
        <strong className="text-[13px] font-semibold">This project is not using Git</strong>
        <span className="text-xs text-dim">{detail}</span>
        {error && <span className="text-xs text-danger">{error}</span>}
      </div>
      {canInit && (
        <button
          className="flex-none px-3.5 py-[7px] font-medium text-warn whitespace-nowrap border border-warn/45 rounded-md enabled:hover:bg-warn/12 disabled:opacity-50 disabled:cursor-not-allowed"
          disabled={pending}
          onClick={() => void initGitRepo(project.id)}
        >
          {pending ? 'Initializing…' : 'Initialize Git repository'}
        </button>
      )}
    </div>
  )
}

export function ProjectOverview({
  project,
  runs,
  onOpenRun,
  onStartTask,
  onOpenSettings
}: Props): JSX.Element {
  const [now, setNow] = useState(Date.now())
  const running = runs.filter((run) => run.status === 'running')
  const reviewable = runs.filter(
    (run) => run.deliveryStatus === 'reviewable'
  )
  const completed = runs.filter(
    (run) => run.status !== 'running' && run.deliveryStatus !== 'reviewable'
  )

  useEffect(() => {
    if (!running.length) return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [running.length])

  const monthUsage = useMemo(() => {
    const date = new Date()
    const monthStart = new Date(date.getFullYear(), date.getMonth(), 1).getTime()
    const current = runs.filter((run) => run.startedAt >= monthStart)
    return {
      tokens: current.reduce((total, run) => total + run.totalTokens, 0),
      cost: current.reduce((total, run) => total + (run.costUsd ?? 0), 0),
      unreportedCosts: current.filter((run) => run.costUsd === null).length
    }
  }, [runs])

  return (
    <div className="h-full p-8 overflow-y-auto max-[980px]:p-[22px]">
      <div className={cn(SPREAD, 'flex gap-6 items-start justify-between mb-6')}>
        <div>
          <span className="text-[11px] font-semibold text-accent uppercase tracking-[0.08em]">
            Project overview
          </span>
          <h1 className="mt-[5px] mb-1.5 text-[26px] font-semibold">{project.name}</h1>
        </div>
      </div>

      <GitAlert project={project} />

      <section className={cn(card, SPREAD)}>
        <div className={SECTION_HEAD}>
          <div>
            <h2 className={SECTION_TITLE}>Usage this month</h2>
            <p className={SECTION_NOTE}>Reported by the agent services used for this project.</p>
          </div>
          <button className={btn.text} onClick={onOpenSettings}>
            Edit limits
          </button>
        </div>
        <div className="grid grid-cols-2 gap-6 max-[980px]:grid-cols-1">
          <UsageMeter
            label="Tokens"
            value={monthUsage.tokens}
            limit={project.monthlyTokenLimit}
            formattedValue={formatTokens(monthUsage.tokens)}
            formattedLimit={formatTokens(project.monthlyTokenLimit ?? 0)}
          />
          <UsageMeter
            label="Cost"
            value={monthUsage.cost}
            limit={project.monthlyCostLimitUsd}
            formattedValue={formatCost(monthUsage.cost)}
            formattedLimit={formatCost(project.monthlyCostLimitUsd ?? 0)}
          />
        </div>
        {monthUsage.unreportedCosts > 0 && (
          <p className="mt-3 text-[11px] text-dim">
            {monthUsage.unreportedCosts} task{monthUsage.unreportedCosts === 1 ? '' : 's'} did not
            report a dollar cost.
          </p>
        )}
      </section>

      <div
        className={cn(SPREAD, 'grid grid-cols-2 gap-4 mt-4 max-[980px]:grid-cols-1')}
      >
        <section className={cn(card, 'min-w-0')}>
          <div className={SECTION_HEAD}>
            <div>
              <h2 className={SECTION_TITLE}>Running</h2>
              <p className={SECTION_NOTE}>{running.length} active</p>
            </div>
          </div>
          <div className={TASK_LIST}>
            {!running.length && <p className={LIST_EMPTY}>No agents are working right now.</p>}
            {running.map((run) => (
              <TaskCard key={run.id} run={run} now={now} onOpen={() => onOpenRun(run.id)} />
            ))}
          </div>
        </section>

        <section className={cn(card, 'min-w-0')}>
          <div className={SECTION_HEAD}>
            <div>
              <h2 className={SECTION_TITLE}>Ready for review</h2>
              <p className={SECTION_NOTE}>{reviewable.length} awaiting your approval</p>
            </div>
          </div>
          <div className={TASK_LIST}>
            {!reviewable.length && <p className={LIST_EMPTY}>No code is waiting for review.</p>}
            {reviewable.map((run) => (
              <TaskCard key={run.id} run={run} now={now} onOpen={() => onOpenRun(run.id)} />
            ))}
          </div>
        </section>
      </div>

      <section className={cn(card, SPREAD, 'mt-4')}>
        <div className={SECTION_HEAD}>
          <div>
            <h2 className={SECTION_TITLE}>Completed</h2>
            <p className={SECTION_NOTE}>Successful no-change tasks, failures, and cancellations</p>
          </div>
        </div>
        <div className={TASK_LIST}>
          {!completed.length && <p className={LIST_EMPTY}>No other completed tasks.</p>}
          {completed.map((run) => (
            <TaskCard key={run.id} run={run} now={now} onOpen={() => onOpenRun(run.id)} />
          ))}
        </div>
      </section>
    </div>
  )
}
