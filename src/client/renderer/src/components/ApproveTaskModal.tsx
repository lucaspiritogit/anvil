import type { JSX } from 'react'
import { useEffect, useRef, useState } from 'react'
import type { TaskMergeAndPushPreview, TaskMergePreview, TaskPushPreview } from '@shared/types'
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
    button: 'Merge',
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

  return (
    <dialog
      ref={dialogRef}
      role="alertdialog"
      aria-labelledby="delivery-task-title"
      aria-describedby="delivery-task-description"
      className={cn(modal.panel, modal.width.narrow, 'm-auto text-fg backdrop:bg-black/55')}
      onCancel={(event) => {
        event.preventDefault()
        if (!submitting.current) onClose()
      }}
    >
      <h2 id="delivery-task-title" className={modal.title}>
        {mergedBeforePushFailed ? 'Task merged; push failed' : labels.title}
      </h2>
      <p id="delivery-task-description" className={cn(modal.copy, 'break-words')}>
        {mergedBeforePushFailed
          ? 'The task was merged locally, but the target branch was not pushed. Close this dialog and use Push to try again.'
          : preview
          ? <DeliveryDescription preview={preview} childCount={childCount} />
          : error ? labels.loadingError : labels.loading}
      </p>
      {error && <p role="alert" className="text-xs text-danger whitespace-pre-wrap break-words">{error}</p>}
      <div className={cn(modal.actions, 'justify-end')}>
        <button autoFocus className={btn.ghost} disabled={busy} onClick={onClose}>{mergedBeforePushFailed ? 'Close' : 'Cancel'}</button>
        {!mergedBeforePushFailed && <button
          className={cn(btn.primary, 'bg-ok disabled:opacity-45')}
          disabled={!preview || busy}
          onClick={() => void confirm()}
        >
          {busy ? labels.busy : labels.button}
        </button>}
      </div>
    </dialog>
  )
}
