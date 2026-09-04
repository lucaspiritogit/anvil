import type { JSX } from 'react'
import { useEffect, useState } from 'react'
import { useStore } from '../state/store'
import type { Run } from '@shared/types'

function StatusDot({ status }: { status: Run['status'] }): JSX.Element {
  return <span className={`dot dot-${status}`} />
}

function formatDuration(run: Run, now: number): string {
  const seconds = Math.max(0, Math.floor(((run.endedAt ?? now) - run.startedAt) / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`
  const hours = Math.floor(minutes / 60)
  return `${hours}h ${minutes % 60}m`
}

function formatTokens(tokens: number): string {
  return `${Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(tokens)} tok`
}

function formatCost(costUsd: number | null): string {
  if (costUsd === null) return 'Cost n/a'
  return `$${costUsd.toFixed(costUsd < 0.01 ? 4 : 2)}`
}

function TaskMetrics({ run, now }: { run: Run; now: number }): JSX.Element {
  const tokenDetail = [
    `${run.inputTokens.toLocaleString()} input`,
    `${run.outputTokens.toLocaleString()} output`,
    `${run.cachedTokens.toLocaleString()} cached`
  ].join(', ')

  return (
    <span className="task-meta" title={tokenDetail}>
      <span>{formatTokens(run.totalTokens)}</span>
      <span>{formatCost(run.costUsd)}</span>
      <span>{formatDuration(run, now)}</span>
    </span>
  )
}

export function Sidebar(): JSX.Element {
  const projects = useStore((s) => s.projects)
  const runs = useStore((s) => s.runs)
  const activeProjectId = useStore((s) => s.activeProjectId)
  const view = useStore((s) => s.view)
  const selectProject = useStore((s) => s.selectProject)
  const addProject = useStore((s) => s.addProject)
  const openRun = useStore((s) => s.openRun)
  const setSettingsOpen = useStore((s) => s.setSettingsOpen)
  const [now, setNow] = useState(Date.now())

  const projectRuns = runs.filter((r) => r.projectId === activeProjectId)
  const hasRunningTask = projectRuns.some((run) => run.status === 'running')

  useEffect(() => {
    if (!hasRunningTask) return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [hasRunningTask])

  return (
    <aside className="sidebar">
      <div className="brand">
        <span className="brand-mark" />
        Anvil
      </div>

      <div className="section-head">
        <span>Projects</span>
        <button className="icon-btn" onClick={() => void addProject()} title="Add project">
          +
        </button>
      </div>

      <nav className="list">
        {projects.length === 0 && <p className="empty">No projects yet.</p>}
        {projects.map((project) => (
          <button
            key={project.id}
            className={`row ${project.id === activeProjectId ? 'row-active' : ''}`}
            onClick={() => selectProject(project.id)}
            title={project.path}
          >
            <span className="row-title">{project.name}</span>
          </button>
        ))}
      </nav>

      {activeProjectId && (
        <>
          <div className="section-head">
            <span>Tasks</span>
          </div>
          <nav className="list list-scroll">
            {projectRuns.length === 0 && <p className="empty">No tasks run yet.</p>}
            {projectRuns.map((run) => (
              <button
                key={run.id}
                className={`row task-row ${view.kind === 'run' && view.runId === run.id ? 'row-active' : ''}`}
                onClick={() => void openRun(run.id)}
                title={run.prompt}
              >
                <StatusDot status={run.status} />
                <span className="task-copy">
                  <span className="row-title">{run.title}</span>
                  <TaskMetrics run={run} now={now} />
                </span>
                {run.deliveryStatus === 'reviewable' && (
                  <span className="sidebar-review-mark" title="Code ready for review">
                    Review
                  </span>
                )}
              </button>
            ))}
          </nav>
        </>
      )}

      <div className="sidebar-foot">
        <button className="ghost-btn" onClick={() => setSettingsOpen(true)}>
          Settings
        </button>
      </div>
    </aside>
  )
}
