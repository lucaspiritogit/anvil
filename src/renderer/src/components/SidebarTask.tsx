import type { JSX } from 'react'
import { useState } from 'react'
import { HugeiconsIcon } from '@hugeicons/react'
import { ArchiveArrowDownIcon, Folder01Icon, Loading03Icon } from '@hugeicons/core-free-icons'
import type { Project, Task } from '@shared/types'
import { canSettleTask, settlementDeadline } from '@shared/task-settlement'
import { useStore } from '../state/store'
import { cn } from '../ui'
import { openTaskContextMenu } from './TaskContextMenu'

function relativeAge(timestamp: number, now: number): string {
  const minutes = Math.max(0, Math.floor((now - timestamp) / 60_000))
  if (minutes < 1) return 'now'
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`
}

export function SidebarTask({ task, project, now, active, compact = false }: {
  task: Task
  project?: Project
  now: number
  active: boolean
  compact?: boolean
}): JSX.Element {
  const openTask = useStore((state) => state.openTask)
  const settleTask = useStore((state) => state.settleTask)
  const [settling, setSettling] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const eligible = canSettleTask(task)
  const deadline = settlementDeadline(task)

  const settle = async (): Promise<void> => {
    if (settling) return
    setSettling(true)
    setError(null)
    try {
      await settleTask(task.id)
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error))
    } finally {
      setSettling(false)
    }
  }

  return (
    <article
      className={cn(
        'group relative rounded-lg transition-colors',
        compact ? 'hover:bg-hover/60' : 'bg-raised/60 hover:bg-hover/70',
        active && 'bg-hover ring-1 ring-inset ring-line'
      )}
    >
      <button
        aria-label={`Open task: ${task.title}`}
        className={cn('w-full min-w-0 text-left rounded-lg focus-visible:outline focus-visible:outline-accent', compact ? 'flex items-center gap-2 px-2.5 py-2' : 'block px-3 py-3')}
        onClick={() => void openTask(task.id)}
        onContextMenu={(event) => openTaskContextMenu(event, task.id)}
        title={task.prompt}
      >
        {compact ? (
          <>
            <HugeiconsIcon icon={Folder01Icon} size={15} className="shrink-0 text-dim" aria-hidden="true" />
            <span className="min-w-0 flex-1 truncate text-xs text-dim">{task.title}</span>
            <span className="shrink-0 text-[10px] text-dim/70">{relativeAge(task.settledAt ?? task.startedAt, now)}</span>
          </>
        ) : (
          <>
            <span className="flex items-center justify-between gap-2 mb-2 text-xs text-dim">
              <span className="flex min-w-0 items-center gap-2">
                <HugeiconsIcon icon={Folder01Icon} size={16} className="shrink-0" aria-hidden="true" />
                <span className="truncate">{project?.name ?? 'Project'}</span>
              </span>
              {task.status === 'running' ? (
                <span className="flex shrink-0 items-center gap-1.5 text-accent">
                  <HugeiconsIcon icon={Loading03Icon} size={14} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />
                  Working
                </span>
              ) : (
                <span className={cn('shrink-0 text-[11px]', eligible && 'group-hover:invisible group-focus-within:invisible')}>
                  {task.deliveryStatus === 'reviewable' ? 'Review' : task.status === 'failed' ? 'Failed' : relativeAge(task.endedAt ?? task.startedAt, now)}
                </span>
              )}
            </span>
            <span className={cn('block truncate text-[13px] font-medium', active || task.status === 'running' ? 'text-fg' : 'text-fg/80')}>
              {task.title}
            </span>
            <span className="block truncate mt-1 font-mono text-[10px] text-dim/65">
              {task.branchName ?? task.agentLabel}
            </span>
          </>
        )}
      </button>
      {!compact && eligible && (
        <button
          aria-label={`Settle task: ${task.title}`}
          title={deadline === undefined ? 'Settle task' : `Settle now. Automatically settles ${new Date(deadline).toLocaleString()}.`}
          className="absolute top-2 right-2 grid size-7 place-items-center rounded-md text-dim bg-raised opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 hover:text-fg hover:bg-hover focus-visible:outline focus-visible:outline-accent disabled:opacity-50"
          disabled={settling}
          onClick={() => void settle()}
        >
          <HugeiconsIcon icon={ArchiveArrowDownIcon} size={16} aria-hidden="true" />
        </button>
      )}
      {error && <p role="alert" className="px-3 pb-2 text-xs text-danger">{error}</p>}
    </article>
  )
}
