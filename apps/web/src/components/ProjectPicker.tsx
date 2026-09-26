import type { FormEvent, JSX, RefObject } from 'react'
import { useRef, useState } from 'react'
import type { Project } from '@anvil/protocol/types'
import { Icon } from '../icons'
import { ChoicePickerDialog } from './ChoicePickerDialog'
import { PickerDialog } from './PickerDialog'
import { DeleteConfirmationDialog } from './DeleteConfirmationDialog'

interface AddProjectDialogProps {
  anchorRef: RefObject<HTMLButtonElement | null>
  onImport: (onProgress: (done: number, total: number) => void) => Promise<Project | null>
  onClone: (url: string) => Promise<Project | null>
  onBack: () => void
  onClose: () => void
  onBusyChange: (busy: boolean) => void
}

function AddProjectDialog({ anchorRef, onImport, onClone, onBack, onClose, onBusyChange }: AddProjectDialogProps): JSX.Element {
  const [mode, setMode] = useState<'choice' | 'clone'>('choice')
  const [url, setUrl] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [progress, setProgress] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const busy = useRef(false)

  const run = async (action: () => Promise<Project | null>): Promise<void> => {
    if (busy.current) return
    busy.current = true
    setSubmitting(true)
    setError(null)
    onBusyChange(true)
    try {
      if (await action()) onClose()
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error))
    } finally {
      busy.current = false
      setSubmitting(false)
      setProgress(null)
      onBusyChange(false)
    }
  }

  const submitClone = (event: FormEvent): void => {
    event.preventDefault()
    const value = url.trim()
    if (value) void run(() => onClone(value))
  }

  const goBack = (): void => {
    if (mode === 'choice') onBack()
    else {
      setMode('choice')
      setError(null)
    }
  }

  const importFromDisk = (): void => {
    void run(() => onImport((done, total) => {
      setProgress(total ? `Uploading project… ${Math.round(done / total * 100)}%` : 'Adding project…')
    }))
  }

  return (
    <PickerDialog anchorRef={anchorRef} label="Add project" onClose={() => { if (!submitting) onClose() }} wide>
      <div className="flex h-full flex-col">
        <div className="flex items-center gap-2 border-b border-line px-3 py-2.5">
          <button type="button" aria-label="Back to projects" disabled={submitting} className="p-1 text-dim hover:bg-hover hover:text-fg focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-45" onClick={goBack}>
            <Icon icon="chevron-left" size={16} />
          </button>
          <h2 className="min-w-0 flex-1 text-sm font-medium">Add project</h2>
          <button type="button" aria-label="Close project picker" disabled={submitting} className="p-1 text-dim hover:bg-hover hover:text-fg focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-45" onClick={onClose}>
            <Icon icon="x" size={14} />
          </button>
        </div>
        {mode === 'choice' ? (
          <div className="flex flex-col gap-1 p-2">
            <button type="button" disabled={submitting} className="flex w-full items-center gap-3 px-3 py-3 text-left text-xs hover:bg-hover focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-45" onClick={importFromDisk}>
              <Icon icon="folder-plus" size={16} />
              Add from disk
            </button>
            <button type="button" disabled={submitting} className="flex w-full items-center gap-3 px-3 py-3 text-left text-xs hover:bg-hover focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-45" onClick={() => { setMode('clone'); setError(null) }}>
              <Icon icon="git-branch" size={16} />
              Clone from git
            </button>
            {progress && <p role="status" className="px-3 py-2 text-xs text-dim">{progress}</p>}
            {error && <p role="alert" className="px-3 py-2 text-xs text-danger">{error}</p>}
          </div>
        ) : (
          <form className="flex min-h-0 flex-1 flex-col p-4" onSubmit={submitClone}>
            <label htmlFor="clone-project-url" className="mb-2 text-xs font-medium">HTTPS repository URL</label>
            <input
              id="clone-project-url"
              type="url"
              required
              autoComplete="off"
              placeholder="https://github.com/owner/repository.git"
              value={url}
              disabled={submitting}
              className="border border-line bg-base px-3 py-2.5 text-xs outline-none placeholder:text-dim focus:border-accent disabled:opacity-45"
              onChange={(event) => setUrl(event.target.value)}
            />
            <p className="mt-3 text-xs leading-5 text-dim">The server will clone this repository into the active workspace. Git credentials must be available on the server.</p>
            <div className="mt-auto">
              {error && <p role="alert" className="pb-2 text-xs text-danger">{error}</p>}
              <button type="submit" disabled={submitting || !url.trim()} className="w-full bg-accent px-3 py-2 text-xs font-medium text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-45">
                {submitting ? 'Cloning repository…' : 'Clone repository'}
              </button>
            </div>
          </form>
        )}
      </div>
    </PickerDialog>
  )
}

export function ProjectPicker({ anchorRef, projects, value, onChange, onImport, onClone, onRemove, onClose, onBusyChange }: {
  anchorRef: RefObject<HTMLButtonElement | null>
  projects: Project[]
  value: string | null
  onChange: (id: string) => void
  onImport: (onProgress: (done: number, total: number) => void) => Promise<Project | null>
  onClone: (url: string) => Promise<Project | null>
  onRemove: (id: string) => Promise<void>
  onClose: () => void
  onBusyChange: (busy: boolean) => void
}): JSX.Element {
  const [view, setView] = useState<'projects' | 'add'>('projects')
  const [deleting, setDeleting] = useState<Project | null>(null)

  if (deleting) return <DeleteConfirmationDialog title="Delete project?" name={deleting.name}
    description={'Remove "{name}" and its tasks from Anvil? This cannot be undone.'}
    fileNotice="The project checkout on disk will not be deleted." confirmLabel="Delete project"
    onConfirm={() => onRemove(deleting.id)} onClose={() => setDeleting(null)} />

  if (view === 'add') return <AddProjectDialog anchorRef={anchorRef} onImport={onImport} onClone={onClone} onBack={() => setView('projects')} onClose={onClose} onBusyChange={onBusyChange} />

  return <ChoicePickerDialog
    anchorRef={anchorRef} label="Choose project" noun="projects" value={value ?? ''}
    choices={projects.map((project) => ({ id: project.id, label: project.name, description: project.path,
      icon: <Icon icon="folder" size={16} className="shrink-0 text-dim" />, onDelete: () => setDeleting(project) }))}
    footer={<div className="border-t border-line p-2"><button type="button" className="flex w-full items-center gap-3 px-3 py-3 text-left text-xs hover:bg-hover focus-visible:outline-2 focus-visible:outline-accent" onClick={() => setView('add')}>
      <Icon icon="folder-plus" size={16} /> Add project
    </button></div>}
    onClose={onClose} onSelect={(id) => { onClose(); onChange(id) }}
  />
}
