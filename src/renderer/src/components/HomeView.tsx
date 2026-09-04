import type { JSX } from 'react'
import { useEffect, useMemo, useState } from 'react'
import { useStore } from '../state/store'
import type { Project, Run } from '@shared/types'

interface Props {
  project: Project
  runs: Run[]
  onOpenRun: (runId: string) => void
  onStartTask: () => void
  onOpenSettings: () => void
}

function formatTokens(value: number): string {
  return Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(value)
}

function formatCost(value: number): string {
  return `$${value.toFixed(value < 0.01 ? 4 : 2)}`
}

function formatDuration(run: Run, now: number): string {
  const seconds = Math.max(0, Math.floor(((run.endedAt ?? now) - run.startedAt) / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

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
    <div className="usage-meter">
      <div className="usage-meter-head">
        <span>{label}</span>
        <span>{limit ? `${formattedValue} of ${formattedLimit}` : `${formattedValue} used`}</span>
      </div>
      <div
        className={`meter-track ${limit ? '' : 'meter-track-unset'} ${limit && value >= limit ? 'meter-over' : ''}`}
      >
        <span style={{ width: `${percent}%` }} />
      </div>
      {!limit && <span className="limit-unset">No monthly limit set</span>}
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
    <button className="home-task" onClick={onOpen}>
      <span className={`dot dot-${run.status}`} />
      <span className="home-task-copy">
        <span className="home-task-title">{run.title}</span>
        <span className="home-task-meta">
          {run.agentLabel} · {formatTokens(run.totalTokens)} tokens · {formatDuration(run, now)}
        </span>
      </span>
      <span className="task-indicators">
        <span className={`task-state task-state-${run.status}`}>{executionLabel}</span>
        {codeLabel && (
          <span className={`code-state code-state-${run.deliveryStatus}`}>{codeLabel}</span>
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
    <div className="git-alert" role="status">
      <div className="git-alert-copy">
        <strong>This project is not using Git</strong>
        <span>{detail}</span>
        {error && <span className="git-alert-error">{error}</span>}
      </div>
      {canInit && (
        <button
          className="git-alert-btn"
          disabled={pending}
          onClick={() => void initGitRepo(project.id)}
        >
          {pending ? 'Initializing…' : 'Initialize Git repository'}
        </button>
      )}
    </div>
  )
}

export function HomeView({
  project,
  runs,
  onOpenRun,
  onStartTask,
  onOpenSettings
}: Props): JSX.Element {
  const [now, setNow] = useState(Date.now())
  const running = runs.filter((run) => run.status === 'running')
  const reviewable = runs.filter(
    (run) => run.status === 'succeeded' && run.deliveryStatus === 'reviewable'
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
    <div className="home-view">
      <div className="home-heading">
        <div>
          <span className="eyebrow">Project overview</span>
          <h1>{project.name}</h1>
        </div>
        <button className="primary-btn" onClick={onStartTask}>
          Start new task
        </button>
      </div>

      <GitAlert project={project} />

      <section className="home-section usage-card">
        <div className="home-section-head">
          <div>
            <h2>Usage this month</h2>
            <p>Reported by the agent services used for this project.</p>
          </div>
          <button className="text-btn" onClick={onOpenSettings}>
            Edit limits
          </button>
        </div>
        <div className="usage-grid">
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
          <p className="usage-note">
            {monthUsage.unreportedCosts} task{monthUsage.unreportedCosts === 1 ? '' : 's'} did not
            report a dollar cost.
          </p>
        )}
      </section>

      <div className="task-columns">
        <section className="home-section task-section">
          <div className="home-section-head">
            <div>
              <h2>Running</h2>
              <p>{running.length} active</p>
            </div>
          </div>
          <div className="home-task-list">
            {!running.length && <p className="home-empty">No agents are working right now.</p>}
            {running.map((run) => (
              <TaskCard key={run.id} run={run} now={now} onOpen={() => onOpenRun(run.id)} />
            ))}
          </div>
        </section>

        <section className="home-section task-section">
          <div className="home-section-head">
            <div>
              <h2>Ready for review</h2>
              <p>{reviewable.length} with code changes</p>
            </div>
          </div>
          <div className="home-task-list">
            {!reviewable.length && <p className="home-empty">No code is waiting for review.</p>}
            {reviewable.map((run) => (
              <TaskCard key={run.id} run={run} now={now} onOpen={() => onOpenRun(run.id)} />
            ))}
          </div>
        </section>
      </div>

      <section className="home-section completed-section">
        <div className="home-section-head">
          <div>
            <h2>Completed</h2>
            <p>Successful no-change tasks, failures, and cancellations</p>
          </div>
        </div>
        <div className="home-task-list">
          {!completed.length && <p className="home-empty">No other completed tasks.</p>}
          {completed.map((run) => (
            <TaskCard key={run.id} run={run} now={now} onOpen={() => onOpenRun(run.id)} />
          ))}
        </div>
      </section>
    </div>
  )
}
