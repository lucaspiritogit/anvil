import type { JSX } from 'react'
import { useEffect, useState } from 'react'
import { formatCost, formatDuration, formatTokens, tokenBreakdown } from '../format'
import { IS_MAC } from '../keys'
import { useStore } from '../state/store'
import { btn, cn, dot } from '../ui'
import type { Run } from '@shared/types'

const SECTION_HEAD =
  'flex items-center justify-between pt-3 px-1.5 pb-1.5 text-[11px] font-semibold text-dim uppercase tracking-[0.08em]'
const ROW = 'flex gap-2 w-full px-2 py-[7px] rounded-md text-left hover:bg-hover hover:text-fg'
const EMPTY = 'mx-2 my-1 text-xs text-dim'
/** Metrics read as one line: every reading after the first is preceded by a dot. */
const METRIC_NEXT = "before:content-['·'] before:mr-[7px] before:text-line"

function TaskMetrics({ run, now }: { run: Run; now: number }): JSX.Element {
  return (
    <span
      className="flex gap-[7px] mt-[3px] overflow-hidden text-[10px] text-dim whitespace-nowrap"
      title={tokenBreakdown(run)}
    >
      <span>{formatTokens(run.totalTokens)} tok</span>
      <span className={METRIC_NEXT}>
        {run.costUsd === null ? 'Cost n/a' : formatCost(run.costUsd)}
      </span>
      <span className={METRIC_NEXT}>{formatDuration(run, now)}</span>
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
  const sidebarCollapsed = useStore((s) => s.sidebarCollapsed)
  const [now, setNow] = useState(Date.now())

  const projectRuns = runs.filter((r) => r.projectId === activeProjectId)
  const hasRunningTask = projectRuns.some((run) => run.status === 'running')

  useEffect(() => {
    if (!hasRunningTask) return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [hasRunningTask])

  // Collapsed, the sidebar is only off-screen, so `inert` keeps its controls
  // out of the tab order while it is hidden.
  return (
    <aside
      className={cn(
        'flex flex-col w-[232px] min-h-0 px-2.5 py-3.5 bg-raised border-r border-line',
        'transition-transform duration-[180ms] ease-[ease] motion-reduce:transition-none',
        sidebarCollapsed && '-translate-x-full'
      )}
      inert={sidebarCollapsed}
    >
      {/* macOS drops its traffic lights into this row, so the brand starts after them. */}
      <div
        className={cn(
          'flex gap-2 items-center pr-1.5 pb-3.5 text-[15px] font-semibold tracking-[0.02em]',
          IS_MAC ? 'drag-region pl-[78px]' : 'pl-1.5'
        )}
      >
        <span className="size-2.5 bg-accent rounded-[3px]" />
        Anvil
      </div>

      <div className={SECTION_HEAD}>
        <span>Projects</span>
        <button
          className={cn(btn.icon, 'no-drag')}
          onClick={() => void addProject()}
          title="Add project"
        >
          +
        </button>
      </div>

      <nav className="flex flex-col gap-0.5">
        {projects.length === 0 && <p className={EMPTY}>No projects yet.</p>}
        {projects.map((project) => (
          <button
            key={project.id}
            className={cn(ROW, 'items-center', project.id === activeProjectId ? 'bg-hover text-fg' : 'text-dim')}
            onClick={() => selectProject(project.id)}
            title={project.path}
          >
            <span className="block truncate">{project.name}</span>
          </button>
        ))}
      </nav>

      {activeProjectId && (
        <>
          <div className={SECTION_HEAD}>
            <span>Tasks</span>
          </div>
          <nav className="flex flex-col gap-0.5 min-h-0 overflow-y-auto">
            {projectRuns.length === 0 && <p className={EMPTY}>No tasks run yet.</p>}
            {projectRuns.map((run) => (
              <button
                key={run.id}
                className={cn(
                  ROW,
                  'items-start',
                  view.kind === 'run' && view.runId === run.id ? 'bg-hover text-fg' : 'text-dim'
                )}
                onClick={() => void openRun(run.id)}
                title={run.prompt}
              >
                <span className={dot(run.status, 'mt-[5px]')} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{run.title}</span>
                  <TaskMetrics run={run} now={now} />
                </span>
                {run.deliveryStatus === 'reviewable' && (
                  <span
                    className="flex-none px-[5px] py-0.5 text-[9px] text-accent border border-accent-edge rounded"
                    title="Code ready for review"
                  >
                    Review
                  </span>
                )}
              </button>
            ))}
          </nav>
        </>
      )}

      <div className="pt-2.5 mt-auto border-t border-line">
        <button className={btn.ghost} onClick={() => setSettingsOpen(true)}>
          Settings
        </button>
      </div>
    </aside>
  )
}
