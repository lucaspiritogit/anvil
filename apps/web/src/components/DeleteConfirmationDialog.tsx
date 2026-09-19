import type { JSX } from 'react'
import { useEffect, useRef, useState } from 'react'
import { Icon } from '../icons'
import { btn, cn, modal } from '../ui'

export function DeleteConfirmationDialog({ title, name, description, fileNotice, confirmLabel, onConfirm, onClose }: {
  title: string
  name: string
  description: string
  fileNotice: string
  confirmLabel: string
  onConfirm: () => Promise<void>
  onClose: () => void
}): JSX.Element {
  const dialog = useRef<HTMLDialogElement>(null)
  const [deleting, setDeleting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    dialog.current?.showModal()
    return () => dialog.current?.close()
  }, [])

  const confirm = async (): Promise<void> => {
    if (deleting) return
    setDeleting(true)
    setError(null)
    try {
      await onConfirm()
      onClose()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      setDeleting(false)
    }
  }

  return <dialog ref={dialog} aria-labelledby="delete-resource-title" aria-describedby="delete-resource-description"
    className={cn(modal.panel, modal.width.narrow, 'm-auto text-fg backdrop:bg-black/55')}
    onCancel={(event) => { event.preventDefault(); if (!deleting) onClose() }}>
    <h2 id="delete-resource-title" className={modal.title}>{title}</h2>
    <p id="delete-resource-description" className={cn(modal.copy, 'break-words')}>{description.replace('{name}', name)}</p>
    <p className={modal.copy}>{fileNotice}</p>
    {error && <p role="alert" className="text-xs text-danger">{error}</p>}
    <div className={cn(modal.actions, 'justify-end')}>
      <button autoFocus type="button" className={btn.ghost} disabled={deleting} onClick={onClose}>Cancel</button>
      <button type="button" className={cn(btn.danger, 'inline-flex items-center gap-2 disabled:cursor-not-allowed disabled:opacity-45')}
        disabled={deleting} onClick={() => void confirm()}>
        <Icon icon="trash" size={15} aria-hidden="true" />
        {deleting ? 'Deleting…' : confirmLabel}
      </button>
    </div>
  </dialog>
}
