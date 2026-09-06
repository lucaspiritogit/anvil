import type { JSX } from 'react'
import { useEffect, useMemo } from 'react'
import { formatCost, formatTokens } from '../format'
import { useStore } from '../state/store'
import { TaskComposer } from './TaskComposer'
import { card, cn } from '../ui'
import type { Project, Task } from '@shared/types'

interface Props {
  project: Project
  tasks: Task[]
}

const SPREAD = 'w-full max-w-[880px] mx-auto'
const SECTION_HEAD = 'flex gap-4 items-center justify-between mb-4'
const SECTION_TITLE = 'mb-1 text-sm font-semibold'
const SECTION_NOTE = 'text-xs text-dim'

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

export function ProjectOverview({ project, tasks }: Props): JSX.Element {
  const monthUsage = useMemo(() => {
    const date = new Date()
    const monthStart = new Date(date.getFullYear(), date.getMonth(), 1).getTime()
    const current = tasks.filter((task) => task.startedAt >= monthStart)
    return {
      tokens: current.reduce((total, task) => total + task.totalTokens, 0),
      cost: current.reduce((total, task) => total + (task.costUsd ?? 0), 0),
      unreportedCosts: current.filter((task) => task.costUsd === null).length
    }
  }, [tasks])

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto px-8 pt-8 pb-6 max-[980px]:px-[22px]">
        <div className={cn(SPREAD, 'mb-6')}>
          <span className="text-[11px] font-semibold text-accent uppercase tracking-[0.08em]">
            Project overview
          </span>
          <h1 className="mt-2 mb-2 text-[30px] font-semibold tracking-tight">{project.name}</h1>
          <p className="text-sm text-dim">What would you like to work on?</p>
        </div>

        <GitAlert project={project} />

        <section className={cn(card, SPREAD)}>
          <div className={SECTION_HEAD}>
            <div>
              <h2 className={SECTION_TITLE}>Usage this month</h2>
              <p className={SECTION_NOTE}>Reported by the agent services used for this project.</p>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-6 max-[760px]:grid-cols-1">
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
      </div>
      <div className="shrink-0 px-8 pt-3 pb-6 max-[980px]:px-[22px]">
        <div className={SPREAD}>
          <TaskComposer key={project.id} project={project} />
        </div>
      </div>
    </div>
  )
}
