import type { JSX } from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { TaskMergeAndPushPreview, TaskMergePreview, TaskPushPreview } from '@anvil/protocol/types'
import { useStore } from '../state/store'
import { btn, cn, modal } from '../ui'

export type TaskDeliveryAction = 'merge' | 'merge-and-push' | 'push'

type DeliveryPreview =
  | { action: 'merge'; value: TaskMergePreview }
  | { action: 'merge-and-push'; value: TaskMergeAndPushPreview }
  | { action: 'push'; value: TaskPushPreview }

const ACTION_LABEL: Record<TaskDeliveryAction, { title: string; button: string; busy: string; loading: string; loadingError: string }> = {
  merge: {
    title: 'Merge task?',
    button: 'Merge task',
    busy: 'Merging…',
    loading: 'Loading merge details…',
    loadingError: 'Could not load the merge details.'
  },
  'merge-and-push': {
    title: 'Merge and push task?',
    button: 'Merge & Push',
    busy: 'Merging & pushing…',
    loading: 'Loading merge and push details…',
    loadingError: 'Could not load the merge and push details.'
  },
  push: {
    title: 'Push merged task?',
    button: 'Push',
    busy: 'Pushing…',
    loading: 'Loading push details…',
    loadingError: 'Could not load the push details.'
  }
}

const BAR_CELLS = 10
const MAX_FILES = 8

interface FileChange {
  path: string
  additions: number
  deletions: number
}

function patchFileChanges(patch: string): FileChange[] {
  const files: FileChange[] = []
  let current: FileChange | null = null
  for (const line of patch.split('\n')) {
    const header = /^diff --git a\/(.+?) b\/(.+)$/.exec(line)
    if (header) {
      current = { path: header[2], additions: 0, deletions: 0 }
      files.push(current)
    } else if (current && line.startsWith('+') && !line.startsWith('+++ ')) current.additions += 1
    else if (current && line.startsWith('-') && !line.startsWith('--- ')) current.deletions += 1
  }
  return files
}

function ChangeBar({ change, scale }: { change: FileChange; scale: number }): JSX.Element {
  const added = Math.min(BAR_CELLS, Math.round(change.additions / scale * BAR_CELLS))
  const removed = Math.min(BAR_CELLS - added, Math.round(change.deletions / scale * BAR_CELLS))
  return (
    <span aria-hidden="true" className="shrink-0 select-none tracking-[-0.02em]">
      <span className="text-ok">{'█'.repeat(added)}</span>
      <span className="text-danger">{'█'.repeat(removed)}</span>
      <span className="text-line-strong">{'░'.repeat(BAR_CELLS - added - removed)}</span>
    </span>
  )
}

function DeliveryDescription({ preview, childCount }: { preview: DeliveryPreview; childCount: number }): JSX.Element {
  if (preview.action === 'push') {
    return <>
      Push <code className="font-mono text-fg">{preview.value.targetBranch}</code> at{' '}
      <code className="font-mono text-fg">{preview.value.targetCommit.slice(0, 8)}</code> to origin.
      {preview.value.remoteTargetCommit === preview.value.targetCommit && ' Origin already points to this commit.'}
    </>
  }

  const merge = preview.value
  return <>
    Merge <code className="font-mono text-fg">{merge.sourceBranch}</code> into{' '}
    <code className="font-mono text-fg">{merge.targetBranch}</code> using git merge.
    {preview.action === 'merge-and-push' && ` Then push ${merge.targetBranch} to origin.`}
    {' '}{merge.commitCount} commit{merge.commitCount === 1 ? '' : 's'} will be brought in.
    {childCount > 0 && ` This will restack ${childCount} stacked task${childCount === 1 ? '' : 's'}. Running agents will finish their turn first.`}
    {merge.commitCount === 0 && ' This branch is already merged.'}
  </>
}

export function ApproveTaskModal({ taskId, action, onClose }: {
  taskId: string
  action: TaskDeliveryAction
  onClose: () => void
}): JSX.Element {
  const childCount = useStore((state) => state.tasks.filter((task) => task.parentTaskId === taskId || task.restackTarget?.parentTaskId === taskId).length)
  const deliveryStatus = useStore((state) => state.tasks.find((task) => task.id === taskId)?.deliveryStatus)
  const patch = useStore((state) => state.diffsByTask[taskId]?.patch)
  const changes = useMemo(() => patch ? patchFileChanges(patch) : [], [patch])
  const scale = Math.max(1, ...changes.map((change) => change.additions + change.deletions))
  const totals = changes.reduce((sum, change) => ({ additions: sum.additions + change.additions, deletions: sum.deletions + change.deletions }), { additions: 0, deletions: 0 })
  const approveTask = useStore((state) => state.approveTask)
  const mergeAndPushTask = useStore((state) => state.mergeAndPushTask)
  const pushTask = useStore((state) => state.pushTask)
  const dialogRef = useRef<HTMLDialogElement>(null)
  const previousFocus = useRef(document.activeElement)
  const submitting = useRef(false)
  const [preview, setPreview] = useState<DeliveryPreview | null>(null)
  const [busy, setBusy] = useState(false)
  const [submitFailed, setSubmitFailed] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const labels = ACTION_LABEL[action]
  const mergedBeforePushFailed = submitFailed && action === 'merge-and-push' && deliveryStatus === 'approved'

  useEffect(() => {
    const dialog = dialogRef.current!
    dialog.showModal()
    let cancelled = false
    const request = action === 'merge'
      ? window.anvil.tasks.mergePreview(taskId).then((value): DeliveryPreview => ({ action, value }))
      : action === 'merge-and-push'
        ? window.anvil.tasks.mergeAndPushPreview(taskId).then((value): DeliveryPreview => ({ action, value }))
        : window.anvil.tasks.pushPreview(taskId).then((value): DeliveryPreview => ({ action, value }))
    void request.then(
      (result) => { if (!cancelled) setPreview(result) },
      (error: unknown) => { if (!cancelled) setError(error instanceof Error ? error.message : String(error)) }
    )
    return () => {
      cancelled = true
      dialog.close()
      const element = previousFocus.current
      if (element instanceof HTMLElement && element.isConnected) element.focus()
    }
  }, [action, taskId])

  const confirm = async (): Promise<void> => {
    if (!preview || submitting.current) return
    submitting.current = true
    setBusy(true)
    setSubmitFailed(false)
    setError(null)
    try {
      if (preview.action === 'merge') await approveTask(taskId, preview.value)
      else if (preview.action === 'merge-and-push') await mergeAndPushTask(taskId, preview.value)
      else await pushTask(taskId, preview.value)
      onClose()
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error))
      setSubmitFailed(true)
      setBusy(false)
      submitting.current = false
    }
  }

  const route = preview
    ? preview.action === 'push'
      ? `${preview.value.targetBranch} → origin`
      : `${preview.value.sourceBranch} → ${preview.value.targetBranch} · ${preview.value.commitCount} commit${preview.value.commitCount === 1 ? '' : 's'}`
    : null
  const showChanges = action !== 'push' && !mergedBeforePushFailed && changes.length > 0

  return (
    <dialog
      ref={dialogRef}
      role="alertdialog"
      aria-labelledby="delivery-task-title"
      aria-describedby="delivery-task-description"
      className={cn('m-auto max-h-[88vh] overflow-y-auto border border-line-strong bg-overlay p-0 text-fg shadow-[0_0_0_1px_var(--color-void)] backdrop:bg-void/75', modal.width.normal)}
      onCancel={(event) => {
        event.preventDefault()
        if (!submitting.current) onClose()
      }}
    >
      <header className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
        <div className="flex min-w-0 flex-col gap-1">
          <h2 id="delivery-task-title" className="font-mono text-base font-semibold tracking-[-0.01em]">
            {mergedBeforePushFailed ? 'Task merged; push failed' : labels.title}
          </h2>
          {route && <span className="truncate font-mono text-[11px] text-dim">{route}</span>}
        </div>
        <button type="button" aria-label="Close dialog" title="Close" disabled={busy} onClick={onClose}
          className="grid size-8 shrink-0 place-items-center text-dim hover:bg-hover hover:text-fg focus-visible:outline-2 focus-visible:outline-accent disabled:text-faint">
          <span aria-hidden="true">✕</span>
        </button>
      </header>
      <p id="delivery-task-description" className="px-5 pt-4 text-[13px] leading-normal text-dim break-words">
        {mergedBeforePushFailed
          ? 'The task was merged locally, but the target branch was not pushed. Close this dialog and use Push to try again.'
          : preview
          ? <DeliveryDescription preview={preview} childCount={childCount} />
          : error ? labels.loadingError : labels.loading}
      </p>
      {showChanges && <ul aria-label="Changed files" className="mt-3 flex flex-col py-1 font-mono text-xs">
        {changes.slice(0, MAX_FILES).map((change) => (
          <li key={change.path} className="grid grid-cols-[minmax(0,1fr)_auto_88px] items-center gap-3 px-5 py-1.5">
            <span className="truncate text-soft" title={change.path}>{change.path}</span>
            <ChangeBar change={change} scale={scale} />
            <span className="text-right tabular-nums text-dim">+{change.additions} −{change.deletions}</span>
          </li>
        ))}
        {changes.length > MAX_FILES && <li className="px-5 py-1.5 text-faint">+{changes.length - MAX_FILES} more file{changes.length - MAX_FILES === 1 ? '' : 's'}</li>}
      </ul>}
      {error && <p role="alert" className="mx-5 mt-3 border border-danger/40 bg-danger-tint px-3 py-2 text-xs text-danger-text whitespace-pre-wrap break-words">{error}</p>}
      <footer className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-line px-5 py-3.5">
        <span className="font-mono text-[11px] text-dim">
          {showChanges && <>{changes.length} file{changes.length === 1 ? '' : 's'} · <span className="text-ok">+{totals.additions}</span> <span className="text-danger">−{totals.deletions}</span></>}
        </span>
        <div className="flex items-center gap-2">
          <button autoFocus className={btn.ghost} disabled={busy} onClick={onClose}>{mergedBeforePushFailed ? 'Close' : 'Cancel'}</button>
          {!mergedBeforePushFailed && <button
            className={btn.primary}
            disabled={!preview || busy}
            onClick={() => void confirm()}
          >
            {busy ? labels.busy : labels.button}
          </button>}
        </div>
      </footer>
    </dialog>
  )
}
