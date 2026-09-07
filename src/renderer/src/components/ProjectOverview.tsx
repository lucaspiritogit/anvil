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

function UsageStat({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-dim">{label}</dt>
      <dd className="mt-1.5 break-words text-[32px] font-semibold leading-tight tracking-tight tabular-nums text-fg">
        {value}
      </dd>
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

        <section aria-labelledby="monthly-usage-title" className={cn(card, SPREAD)}>
          <div className={SECTION_HEAD}>
            <div>
              <h2 id="monthly-usage-title" className={SECTION_TITLE}>Usage this month</h2>
              <p className={SECTION_NOTE}>Reported by the agent services used for this project.</p>
            </div>
          </div>
          <dl className="grid grid-cols-2 gap-6 max-[760px]:grid-cols-1">
            <UsageStat label="Tokens used" value={formatTokens(monthUsage.tokens)} />
            <UsageStat label="Cost in USD" value={formatCost(monthUsage.cost)} />
          </dl>
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
          <TaskComposer key={project.id} />
        </div>
      </div>
    </div>
  )
}
