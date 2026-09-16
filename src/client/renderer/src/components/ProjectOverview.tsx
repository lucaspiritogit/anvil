import type { JSX } from 'react'
import { useEffect, useState } from 'react'
import { useStore } from '../state/store'
import { TaskComposer } from './TaskComposer'
import { cn } from '../ui'
import type { CodexRateLimitWindow, CodexRateLimits, Project } from '@shared/types'
import { ProviderIcon } from './ProviderIcon'
import { AsciiMeter } from './AsciiMeter'

interface Props {
  project?: Project
}

const SPREAD = 'w-full max-w-[1040px] mx-auto'

function weeklyLimit(limits: CodexRateLimits): CodexRateLimitWindow | null {
  const codex = limits.rateLimitsByLimitId?.codex ?? limits.rateLimits
  return codex?.secondary ?? codex?.primary ?? null
}

function resetLabel(timestamp: number): string {
  return `Resets ${new Intl.DateTimeFormat(undefined, {
    weekday: 'short', hour: 'numeric', minute: '2-digit'
  }).format(new Date(timestamp * 1000))}`
}

function CodexLimits(): JSX.Element | null {
  const workspaceId = useStore((state) => state.activeWorkspaceId)
  const [limitWindow, setLimitWindow] = useState<CodexRateLimitWindow | null>(null)

  useEffect(() => {
    let active = true
    const load = async (): Promise<void> => {
      if (!workspaceId) return
      try {
        const limits = await window.anvil.accounts.rateLimits({ workspaceId, agentId: 'codex' })
        if (active) setLimitWindow(weeklyLimit(limits))
      } catch {
        if (active) setLimitWindow(null)
      }
    }
    setLimitWindow(null)
    void load()
    const timer = window.setInterval(() => { void load() }, 60_000)
    return () => {
      active = false
      window.clearInterval(timer)
    }
  }, [workspaceId])

  if (!limitWindow) return null
  const remaining = Math.max(0, Math.min(100, 100 - limitWindow.usedPercent))
  return (
    <section
      aria-label="Codex usage limits"
      className={cn(SPREAD, 'mt-8 flex shrink-0 items-center gap-4 border-t border-dashed border-line/70 px-1 pt-4 max-[700px]:mt-5 max-[700px]:gap-3')}
    >
      <div className="flex shrink-0 items-center gap-2 text-xs font-medium text-foreground">
        <ProviderIcon company="OpenAI" size={18} />
        <span>ChatGPT</span>
      </div>
      <AsciiMeter
        className="min-w-0 flex-1"
        label="Weekly"
        value={resetLabel(limitWindow.resetsAt)}
        ratio={remaining / 100}
        width={24}
        percentLabel={`${Math.round(remaining)}% left`}
      />
    </section>
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
      ? 'Agents will run directly in the project folder. Task branches and reviewable diffs are skipped.'
      : 'Git could not be run on this machine, so task branches and reviewable diffs are skipped.'

  return (
    <div
      className={cn(
        'flex gap-4 items-center justify-between px-[18px] py-3.5 mb-6',
        'max-[700px]:mb-4 max-[700px]:flex-col max-[700px]:items-stretch max-[700px]:gap-3 max-[700px]:px-4',
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
          className="flex-none self-start px-3.5 py-[7px] font-medium text-warn whitespace-nowrap border border-warn/45 enabled:hover:bg-warn/12 disabled:opacity-50 disabled:cursor-not-allowed"
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
      className="relative flex h-full min-h-0 flex-col overflow-x-hidden overflow-y-auto px-8 py-8 max-[980px]:px-[22px] max-[700px]:px-3 max-[700px]:py-2"
    >
      <div className={cn(SPREAD, 'my-auto')}>
        {project && <GitAlert project={project} />}
        <TaskComposer key={project?.id ?? 'no-project'} />
      </div>
      <CodexLimits />
    </div>
  )
}
