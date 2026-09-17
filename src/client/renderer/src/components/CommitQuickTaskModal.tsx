import type { JSX } from 'react'
import { useEffect, useRef, useState } from 'react'
import type { Task } from '@shared/types'
import { btn, cn, field, modal } from '../ui'
import { AiGenerateButton } from './AiGenerateButton'

export function CommitQuickTaskModal({ task, push, onClose }: { task: Task; push: boolean; onClose: () => void }): JSX.Element {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const previousFocus = useRef(document.activeElement)
  const inFlight = useRef(false)
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState<'drafting' | 'committing' | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const dialog = dialogRef.current!
    dialog.showModal()
    return () => {
      dialog.close()
      const element = previousFocus.current
      if (element instanceof HTMLElement && element.isConnected) element.focus()
    }
  }, [])

  const commit = async (): Promise<void> => {
    if (inFlight.current) return
    inFlight.current = true
    setBusy('committing')
    setError(null)
    try {
      await window.anvil.tasks.commitQuick({ taskId: task.id, push, message: message.trim() })
      onClose()
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      inFlight.current = false
      setBusy(null)
    }
  }

  const fileCount = task.reviewPaths?.length ?? 0

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby="commit-quick-title"
      aria-describedby="commit-quick-description"
      className={cn(modal.panel, modal.width.normal, 'm-auto text-fg backdrop:bg-black/55')}
      onCancel={(event) => { event.preventDefault(); if (!inFlight.current && busy === null) onClose() }}
    >
      <h2 id="commit-quick-title" className={modal.title}>{push ? 'Commit & Push' : 'Commit task changes'}</h2>
      <p id="commit-quick-description" className={cn(modal.copy, 'break-words')}>
        Commit {fileCount} file{fileCount === 1 ? '' : 's'} this task modified to the current branch{push ? ', then push it to the remote' : ''}.
        Other staged or working-tree changes are left untouched.
      </p>
      <div className={field.wrap}>
        <label htmlFor="commit-message" className={field.label}>Commit message</label>
        <div className="flex gap-2">
          <textarea
            id="commit-message"
            className={cn(field.sized, 'min-w-0 flex-1 resize-y')}
            rows={3}
            value={message}
            maxLength={65_536}
            disabled={busy !== null}
            onChange={(event) => setMessage(event.target.value)}
          />
          <AiGenerateButton
            noun="commit message"
            agentLabel={task.agentLabel}
            disabled={busy !== null}
            generate={() => window.anvil.tasks.draftCommitMessage({ taskId: task.id, message })}
            onGenerated={setMessage}
            onError={setError}
            onBusyChange={(active) => {
              if (active) setError(null)
              setBusy(active ? 'drafting' : null)
            }}
          />
        </div>
      </div>
      {busy && <p role="status" className="text-xs text-dim">
        {busy === 'committing' ? push ? 'Committing and pushing…' : 'Committing…' : `${task.agentLabel} is writing the commit message…`}
      </p>}
      {error && <p role="alert" className="mt-2 text-xs text-danger whitespace-pre-wrap break-words">{error}</p>}
      <div className={cn(modal.actions, 'justify-end')}>
        <button autoFocus className={btn.ghost} disabled={busy !== null} onClick={onClose}>Cancel</button>
        <button className={btn.primary} disabled={!message.trim() || busy !== null} onClick={() => void commit()}>
          {busy === 'committing' ? 'Committing…' : push ? 'Commit & Push' : 'Commit'}
        </button>
      </div>
    </dialog>
  )
}
