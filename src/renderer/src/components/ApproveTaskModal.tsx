import type { JSX } from 'react'
import { useEffect, useRef, useState } from 'react'
import type { TaskMergePreview } from '@shared/types'
import { useStore } from '../state/store'
import { btn, cn, modal } from '../ui'

export function ApproveTaskModal({ taskId, onClose }: { taskId: string; onClose: () => void }): JSX.Element {
  const childCount = useStore((state) => state.tasks.filter((task) => task.parentTaskId === taskId || task.restackTarget?.parentTaskId === taskId).length)
  const approveTask = useStore((state) => state.approveTask)
  const dialogRef = useRef<HTMLDialogElement>(null)
  const previousFocus = useRef(document.activeElement)
  const submitting = useRef(false)
  const [preview, setPreview] = useState<TaskMergePreview | null>(null)
  const [merging, setMerging] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const dialog = dialogRef.current!
    dialog.showModal()
    let cancelled = false
    void window.anvil.tasks.mergePreview(taskId).then(
      (result) => { if (!cancelled) setPreview(result) },
      (error: unknown) => { if (!cancelled) setError(error instanceof Error ? error.message : String(error)) }
    )
    return () => {
      cancelled = true
      dialog.close()
      const element = previousFocus.current
      if (element instanceof HTMLElement && element.isConnected) element.focus()
    }
  }, [taskId])

  const confirm = async (): Promise<void> => {
    if (!preview || submitting.current) return
    submitting.current = true
    setMerging(true)
    setError(null)
    try {
      await approveTask(taskId, preview)
      onClose()
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error))
      setMerging(false)
      submitting.current = false
    }
  }

  return (
    <dialog
      ref={dialogRef}
      role="alertdialog"
      aria-labelledby="approve-task-title"
      aria-describedby="approve-task-description"
      className={cn(modal.panel, modal.width.narrow, 'm-auto text-fg backdrop:bg-black/55')}
      onCancel={(event) => {
        event.preventDefault()
        if (!submitting.current) onClose()
      }}
    >
      <h2 id="approve-task-title" className={modal.title}>Merge and approve?</h2>
      <p id="approve-task-description" className={cn(modal.copy, 'break-words')}>
        {preview ? <>
          Merge <code className="font-mono text-fg">{preview.sourceBranch}</code> into{' '}
          <code className="font-mono text-fg">{preview.targetBranch}</code> using git merge.
          {' '}{preview.commitCount} commit{preview.commitCount === 1 ? '' : 's'} will be brought in.
          {childCount > 0 && ` This will restack ${childCount} stacked task${childCount === 1 ? '' : 's'}. Running agents will finish their turn first.`}
          {preview.commitCount === 0 && ' This branch is already merged.'}
        </> : error ? 'Could not load the merge details.' : 'Loading merge details…'}
      </p>
      {error && <p role="alert" className="text-xs text-danger whitespace-pre-wrap break-words">{error}</p>}
      <div className={cn(modal.actions, 'justify-end')}>
        <button autoFocus className={btn.ghost} disabled={merging} onClick={onClose}>Cancel</button>
        <button
          className={cn(btn.primary, 'bg-ok disabled:opacity-45')}
          disabled={!preview || merging}
          onClick={() => void confirm()}
        >
          {merging ? 'Merging…' : 'Merge and approve'}
        </button>
      </div>
    </dialog>
  )
}
