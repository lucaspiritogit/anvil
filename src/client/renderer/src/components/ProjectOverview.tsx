import type { JSX } from 'react'
import { useEffect } from 'react'
import { useStore } from '../state/store'
import { TaskComposer } from './TaskComposer'
import { cn } from '../ui'
import type { Project } from '@shared/types'

interface Props {
  project: Project
}

const SPREAD = 'w-full max-w-[1040px] mx-auto'

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
      ? 'Agents will run directly in the project folder. Task branches and reviewable diffs are skipped.'
      : 'Git could not be run on this machine, so task branches and reviewable diffs are skipped.'

  return (
    <div
      className={cn(
        'flex gap-4 items-center justify-between px-[18px] py-3.5 mb-6',
        'text-warn bg-warn/8 border border-warn/35'
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
          className="flex-none px-3.5 py-[7px] font-medium text-warn whitespace-nowrap border border-warn/45 enabled:hover:bg-warn/12 disabled:opacity-50 disabled:cursor-not-allowed"
          disabled={pending}
          onClick={() => void initGitRepo(project.id)}
        >
          {pending ? 'Initializing…' : 'Initialize Git repository'}
        </button>
      )}
    </div>
  )
}

export function ProjectOverview({ project }: Props): JSX.Element {
  return (
    <div
      data-testid="project-overview"
      className="relative flex h-full min-h-0 flex-col overflow-y-auto px-8 py-8 max-[980px]:px-[22px]"
    >
      <div className={cn(SPREAD, 'my-auto')}>
        <GitAlert project={project} />
        <TaskComposer key={project.id} />
      </div>
    </div>
  )
}
