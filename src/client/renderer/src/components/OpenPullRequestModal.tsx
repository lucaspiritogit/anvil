import type { JSX } from 'react'
import { useEffect, useRef, useState } from 'react'
import { Icon } from '../icons'
import type { PullRequestField, PullRequestInfo, PullRequestPreview, Task } from '@shared/types'
import { btn, cn, field, modal } from '../ui'

export function OpenPullRequestModal({ task, onClose }: { task: Task; onClose: () => void }): JSX.Element {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const previousFocus = useRef(document.activeElement)
  const inFlight = useRef(false)
  const [preview, setPreview] = useState<PullRequestPreview | null>(null)
  const [title, setTitle] = useState(task.title)
  const [description, setDescription] = useState('')
  const [busy, setBusy] = useState<PullRequestField | 'opening' | null>(null)
  const [result, setResult] = useState<PullRequestInfo | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [previewError, setPreviewError] = useState<string | null>(null)

  useEffect(() => {
    const dialog = dialogRef.current!
    dialog.showModal()
    let cancelled = false
    void window.anvil.github.preview(task.id).then(
      (preview) => { if (!cancelled) setPreview(preview) },
      (error: unknown) => { if (!cancelled) setPreviewError(error instanceof Error ? error.message : String(error)) }
    )
    return () => {
      cancelled = true
      dialog.close()
      const element = previousFocus.current
      if (element instanceof HTMLElement && element.isConnected) element.focus()
    }
  }, [task.id])

  const generate = async (field: PullRequestField): Promise<void> => {
    if (inFlight.current) return
    inFlight.current = true
    setBusy(field)
    setError(null)
    try {
      const draft = await window.anvil.github.draftField({ taskId: task.id, field, title, description })
      if (field === 'title') setTitle(draft)
      else setDescription(draft)
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error))
    } finally {
      inFlight.current = false
      setBusy(null)
    }
  }

  const open = async (): Promise<void> => {
    if (!preview || inFlight.current) return
    inFlight.current = true
    setBusy('opening')
    setError(null)
    try {
      setResult(await window.anvil.github.openPullRequest({ taskId: task.id, preview, title, description }))
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error))
    } finally {
      inFlight.current = false
      setBusy(null)
    }
  }

  const sparkles = (field: PullRequestField): JSX.Element => (
    <button
      className={cn(btn.ghost, 'shrink-0 self-start p-2')}
      aria-label={`Generate PR ${field} with ${task.agentLabel}`}
      title={`Let ${task.agentLabel} write the ${field}`}
      disabled={busy !== null}
      onClick={() => void generate(field)}
    >
      <Icon icon="sparkles" size={18} className={busy === field ? 'animate-pulse' : ''} />
    </button>
  )

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby="open-pr-title"
      aria-describedby="open-pr-description"
      className={cn(modal.panel, modal.width.normal, 'm-auto text-fg backdrop:bg-black/55')}
      onCancel={(event) => { event.preventDefault(); if (!inFlight.current) onClose() }}
    >
      <h2 id="open-pr-title" className={modal.title}>{result ? result.existing ? 'PR already open' : 'Pull request created' : 'Open PR'}</h2>
      {result ? <>
        <p id="open-pr-description" className={cn(modal.copy, 'break-words')}>
          <strong>#{result.number} {result.title}</strong><br />
          {result.sourceBranch} into {result.targetBranch}, opened by {result.author}.
        </p>
        <a className="text-accent break-all underline" href={result.url} onClick={(event) => {
          event.preventDefault()
          void window.anvil.github.openUrl(result.url).catch((error: unknown) => setError(error instanceof Error ? error.message : String(error)))
        }}>{result.url}</a>
        {result.description && <p className="mt-3 text-xs text-dim whitespace-pre-wrap break-words">{result.description}</p>}
        <p className={cn(modal.copy, 'mt-3')}>Opening a PR does not merge this task locally.</p>
      </> : <>
        <p id="open-pr-description" className={cn(modal.copy, 'break-words')}>
          {preview ? <>
            Push <code className="font-mono text-fg">{preview.sourceBranch}</code> to {preview.repository} via {preview.remote}, then
            open a PR into <code className="font-mono text-fg">{preview.targetBranch}</code> as <strong>{preview.account}</strong>.
            {' '}{preview.commitCount} commit{preview.commitCount === 1 ? '' : 's'} will be proposed against the remote branch.
          </> : previewError ? 'Could not load PR details. Check your GitHub token and origin remote, then reopen this dialog.' : 'Loading repository and branch details…'}
        </p>
        {preview?.commitCount === 0 && <p className={modal.copy}>There are no commits to propose against this remote branch.</p>}
        <div className={field.wrap}>
          <label htmlFor="pr-title" className={field.label}>Title</label>
          <div className="flex gap-2">
            <input id="pr-title" className={cn(field.sized, 'min-w-0 flex-1')} value={title} maxLength={256} disabled={busy !== null} onChange={(event) => setTitle(event.target.value)} />
            {sparkles('title')}
          </div>
        </div>
        <div className={field.wrap}>
          <label htmlFor="pr-description" className={field.label}>Description</label>
          <div className="flex gap-2">
            <textarea id="pr-description" className={cn(field.sized, 'min-w-0 flex-1 resize-y')} rows={6} value={description} maxLength={65_536} disabled={busy !== null} onChange={(event) => setDescription(event.target.value)} />
            {sparkles('description')}
          </div>
        </div>
        {busy && <p role="status" className="text-xs text-dim">{busy === 'opening' ? 'Pushing branch and opening PR…' : `${task.agentLabel} is writing the ${busy}…`}</p>}
      </>}
      {(error || previewError) && <p role="alert" className="mt-2 text-xs text-danger whitespace-pre-wrap break-words">{error || previewError}</p>}
      <div className={cn(modal.actions, 'justify-end')}>
        <button autoFocus className={btn.ghost} disabled={busy !== null} onClick={onClose}>{result ? 'Close' : 'Cancel'}</button>
        {!result && <button className={btn.primary} disabled={!preview || preview.commitCount < 1 || !title.trim() || busy !== null} onClick={() => void open()}>
          {busy === 'opening' ? 'Opening PR…' : 'Open PR'}
        </button>}
      </div>
    </dialog>
  )
}
