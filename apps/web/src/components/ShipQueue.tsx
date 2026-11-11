import type { JSX } from 'react'
import { useEffect, useMemo, useState } from 'react'
import type { Task } from '@anvil/protocol/types'
import { isTaskSettled } from '@anvil/protocol/task-settlement'
import { taskRiskFlags, type RiskFlag } from '@anvil/protocol/task-risk'
import { useStore } from '../state/store'
import { btn, cn } from '../ui'
import { ShipButton } from './ShipButton'
import { ShipChecks, checksAreCurrent } from './ShipChecks'

const BLOCKING_RISKS = new Set(['secrets', 'migration', 'ci'])

export function isShipQueueTask(task: Task): boolean {
  return task.status === 'succeeded' && task.deliveryStatus === 'reviewable' && !isTaskSettled(task)
}

function readyForBatch(task: Task, flags: RiskFlag[] | undefined): boolean {
  if (!flags || task.parentTaskId || task.restackState) return false
  if (flags.some((flag) => BLOCKING_RISKS.has(flag.kind))) return false
  return task.checks?.status === 'passed' && checksAreCurrent(task)
}

function QueueRow({ task, flags }: { task: Task; flags?: RiskFlag[] }): JSX.Element {
  const project = useStore((s) => s.projects.find((item) => item.id === task.projectId))
  const diffLoaded = useStore((s) => Boolean(s.diffsByTask[task.id]))
  const openTask = useStore((s) => s.openTask)
  return <li className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-2 border-b border-line px-5 py-3.5 @max-[760px]:grid-cols-1">
    <div className="min-w-0">
      <button type="button" className="block max-w-full truncate text-left font-mono text-[13.5px] font-semibold hover:text-ember-300 focus-visible:outline-2 focus-visible:outline-accent"
        title={task.title} onClick={() => void openTask(task.id)}>
        {task.title}
      </button>
      <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[11px] text-dim">
        <span className="truncate">{project?.name ?? 'No project'}</span>
        {task.branchName && <span className="truncate" title={task.branchName}>{task.branchName}</span>}
        <span className="tabular-nums">{task.filesChanged} file{task.filesChanged === 1 ? '' : 's'} <span className="text-ok">+{task.additions}</span> <span className="text-danger">−{task.deletions}</span></span>
        {flags?.map((flag) => <span key={flag.kind} title={flag.files.join('\n')}
          className={cn('border px-1.5', BLOCKING_RISKS.has(flag.kind) ? 'border-warn/40 bg-warn-tint text-warn-text' : 'border-line-strong text-soft')}>
          {flag.label}
        </span>)}
      </div>
    </div>
    <div className="flex shrink-0 flex-wrap items-center justify-end gap-2 text-xs @max-[760px]:justify-start">
      <ShipChecks task={task} />
      <ShipButton
        task={task}
        disabled={!diffLoaded || Boolean(task.parentTaskId || task.restackState)}
        disabledReason={task.restackState ? 'Finish restacking before shipping' : task.parentTaskId ? 'Ship the parent task first' : undefined}
      />
    </div>
  </li>
}

export function ShipQueue(): JSX.Element {
  const tasks = useStore((s) => s.tasks)
  const diffs = useStore((s) => s.diffsByTask)
  const loadTaskDiff = useStore((s) => s.loadTaskDiff)
  const shipTask = useStore((s) => s.shipTask)
  const queue = useMemo(() => tasks.filter(isShipQueueTask).sort((a, b) => (b.endedAt ?? b.startedAt) - (a.endedAt ?? a.startedAt)), [tasks])
  const flagsByTask = useMemo(() => Object.fromEntries(queue.map((task) => {
    const diff = diffs[task.id]
    return [task.id, diff ? taskRiskFlags(diff.patch, task.expectedFiles) : undefined]
  })), [diffs, queue])
  const batch = queue.filter((task) => readyForBatch(task, flagsByTask[task.id]))
  const [shipping, setShipping] = useState<{ done: number; total: number } | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    for (const task of queue) if (!diffs[task.id]) void loadTaskDiff(task.id)
  }, [diffs, loadTaskDiff, queue])

  const shipAll = async (): Promise<void> => {
    const targets = [...batch]
    setShipping({ done: 0, total: targets.length })
    setError('')
    for (const [index, task] of targets.entries()) {
      try {
        const shipped = await shipTask(task.id)
        if (shipped.deliveryStatus !== 'approved') {
          setError(`${task.title} hit a merge conflict. Resolve it from the task, then ship the rest.`)
          break
        }
      } catch (failure) {
        setError(`${task.title}: ${failure instanceof Error ? failure.message : String(failure)}`)
        break
      }
      setShipping({ done: index + 1, total: targets.length })
    }
    setShipping(null)
  }

  return <div className="@container flex h-full min-h-0 min-w-0 flex-col">
    <header className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-line px-5 pt-4 pb-3">
      <div className="min-w-0">
        <h1 className="font-mono text-[15px] font-semibold tracking-[-0.01em]">Ready to ship</h1>
        <p className="mt-1 text-xs text-dim">
          {queue.length
            ? `${queue.length} task${queue.length === 1 ? '' : 's'} finished with changes. ${batch.length} passed checks with nothing risky.`
            : 'Tasks that finish with changes show up here.'}
        </p>
      </div>
      {queue.length > 0 && <button className={cn(btn.primary, 'bg-ok')} disabled={!batch.length || shipping !== null}
        title="Ships every task whose checks passed and that touches no secrets, migrations or CI config, one at a time"
        onClick={() => void shipAll()}>
        {shipping ? `Shipping ${shipping.done + 1} of ${shipping.total}…` : `Ship ${batch.length} passing`}
      </button>}
    </header>
    {error && <p role="alert" className="shrink-0 bg-danger/8 px-5 py-2 text-xs text-danger">{error}</p>}
    {queue.length
      ? <ul aria-label="Tasks ready to ship" className="min-h-0 flex-1 overflow-y-auto">
        {queue.map((task) => <QueueRow key={task.id} task={task} flags={flagsByTask[task.id]} />)}
      </ul>
      : <div className="grid flex-1 place-content-center p-6 text-center text-sm text-dim">Nothing is waiting to ship.</div>}
  </div>
}
