import type { JSX } from 'react'
import { useEffect, useRef, useState } from 'react'
import type { BranchSyncStatus, Task } from '@anvil/protocol/types'
import { btn, cn, field, modal } from '../ui'
import { AiGenerateButton } from './AiGenerateButton'

type SyncState =
  | { kind: 'checking' }
  | { kind: 'ready'; status: BranchSyncStatus }
  | { kind: 'failed'; message: string }

const plural = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? '' : 's'}`

function SyncBanner({ sync, push, pulling, onPull }: {
  sync: SyncState
  push: boolean
  pulling: boolean
  onPull: () => void
}): JSX.Element {
  if (sync.kind === 'checking') return <p role="status" className="mb-3 text-xs text-dim">Checking origin for new commits…</p>
  if (sync.kind === 'failed') {
    return <p role="status" className="mb-3 text-xs text-warn whitespace-pre-wrap break-words">
      Could not check origin{push ? '' : ', but you can still commit locally'}: {sync.message}
    </p>
  }
  const { branch, remoteCommit, ahead, behind, overlappingPaths } = sync.status
  const remote = `origin/${branch}`
  if (!remoteCommit) return <p className="mb-3 text-xs text-dim">{branch} is not on origin yet.</p>
  if (!behind) {
    return <p className="mb-3 text-xs text-ok">
      Up to date with {remote}{ahead ? ` · ${plural(ahead, 'local commit')} not pushed` : ''}.
    </p>
  }
  const incoming = `${remote} has ${plural(behind, 'new commit')}`
  if (ahead) {
    return <p role="alert" className="mb-3 text-xs text-warn">
      {branch} and {remote} have diverged ({plural(ahead, 'local commit')}, {plural(behind, 'remote commit')}). Reconcile them before {push ? 'pushing' : 'committing'}.
    </p>
  }
  if (overlappingPaths.length) {
    return <div role="alert" className="mb-3 text-xs text-warn">
      <p>{incoming} that change files you modified locally, so it cannot be pulled automatically:</p>
      <ul className="mt-1 max-h-24 overflow-y-auto font-mono text-fg">
        {overlappingPaths.map((path) => <li key={path} className="truncate" title={path}>{path}</li>)}
      </ul>
    </div>
  }
  return <div role="alert" className="mb-3 flex items-center justify-between gap-3 border border-line-strong bg-overlay px-3 py-2 text-xs">
    <span className="text-warn">{incoming}. Pull before {push ? 'pushing' : 'committing'}.</span>
    <button className={btn.ghost} disabled={pulling} onClick={onPull}>{pulling ? 'Pulling…' : 'Pull'}</button>
  </div>
}

export function CommitQuickTaskModal({ task, push, onClose }: { task: Task; push: boolean; onClose: () => void }): JSX.Element {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const previousFocus = useRef(document.activeElement)
  const inFlight = useRef(false)
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState<'drafting' | 'committing' | 'pulling' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [sync, setSync] = useState<SyncState>({ kind: 'checking' })

  useEffect(() => {
    const dialog = dialogRef.current!
    dialog.showModal()
    return () => {
      dialog.close()
      const element = previousFocus.current
      if (element instanceof HTMLElement && element.isConnected) element.focus()
    }
  }, [])

  useEffect(() => {
    let current = true
    window.anvil.tasks.syncStatus(task.id).then(
      (status) => { if (current) setSync({ kind: 'ready', status }) },
      (failure: unknown) => { if (current) setSync({ kind: 'failed', message: failure instanceof Error ? failure.message : String(failure) }) }
    )
    return () => { current = false }
  }, [task.id])

  const pull = async (): Promise<void> => {
    if (inFlight.current || sync.kind !== 'ready' || !sync.status.remoteCommit) return
    inFlight.current = true
    setBusy('pulling')
    setError(null)
    try {
      const { branch, localCommit, remoteCommit } = sync.status
      setSync({ kind: 'ready', status: await window.anvil.tasks.pull({ taskId: task.id, branch, localCommit, remoteCommit }) })
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      inFlight.current = false
      setBusy(null)
    }
  }

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
  const pushBlocked = push && sync.kind === 'ready' && sync.status.behind > 0

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
      <SyncBanner sync={sync} push={push} pulling={busy === 'pulling'} onPull={() => void pull()} />
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
      {busy && busy !== 'pulling' && <p role="status" className="text-xs text-dim">
        {busy === 'committing' ? push ? 'Committing and pushing…' : 'Committing…' : `${task.agentLabel} is writing the commit message…`}
      </p>}
      {error && <p role="alert" className="mt-2 text-xs text-danger whitespace-pre-wrap break-words">{error}</p>}
      <div className={cn(modal.actions, 'justify-end')}>
        <button autoFocus className={btn.ghost} disabled={busy !== null} onClick={onClose}>Cancel</button>
        <button className={btn.primary} disabled={!message.trim() || busy !== null || pushBlocked} onClick={() => void commit()}>
          {busy === 'committing' ? 'Committing…' : push ? 'Commit & Push' : 'Commit'}
        </button>
      </div>
    </dialog>
  )
}
