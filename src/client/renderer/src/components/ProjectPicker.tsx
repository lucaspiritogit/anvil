import type { FormEvent, JSX, RefObject } from 'react'
import { useEffect, useRef, useState } from 'react'
import type { Project, ProjectDirectoryListing } from '@shared/types'
import { Icon } from '../icons'
import { ChoicePickerDialog } from './ChoicePickerDialog'
import { PickerDialog } from './PickerDialog'

type AddMode = 'folder' | 'clone'

function AddProjectDialog({ anchorRef, onAdd, onClone, onBack, onClose, onBusyChange }: {
  anchorRef: RefObject<HTMLButtonElement | null>
  onAdd: (path: string) => Promise<Project | null>
  onClone: (url: string) => Promise<Project | null>
  onBack: () => void
  onClose: () => void
  onBusyChange: (busy: boolean) => void
}): JSX.Element {
  const [mode, setMode] = useState<AddMode>('folder')
  const [listing, setListing] = useState<ProjectDirectoryListing | null>(null)
  const [path, setPath] = useState('')
  const [url, setUrl] = useState('')
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const browseRequest = useRef(0)

  const browse = async (nextPath?: string): Promise<void> => {
    const request = ++browseRequest.current
    setLoading(true)
    setError(null)
    try {
      const next = await window.anvil.projects.browse(nextPath)
      if (request !== browseRequest.current) return
      setListing(next)
      setPath(next.path)
    } catch (error) {
      if (request === browseRequest.current) setError(error instanceof Error ? error.message : String(error))
    } finally {
      if (request === browseRequest.current) setLoading(false)
    }
  }

  useEffect(() => {
    void browse()
    return () => { browseRequest.current += 1 }
  }, [])

  const run = async (action: () => Promise<Project | null>): Promise<void> => {
    if (submitting) return
    setSubmitting(true)
    setError(null)
    onBusyChange(true)
    try {
      if (await action()) onClose()
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error))
    } finally {
      setSubmitting(false)
      onBusyChange(false)
    }
  }

  const submitPath = (event?: FormEvent): void => {
    event?.preventDefault()
    const value = path.trim()
    if (value) void browse(value)
  }

  const submitClone = (event?: FormEvent): void => {
    event?.preventDefault()
    const value = url.trim()
    if (value) void run(() => onClone(value))
  }

  const close = (): void => { if (!submitting) onClose() }
  const back = (): void => { if (!submitting) onBack() }

  return (
    <PickerDialog anchorRef={anchorRef} label="Add project" onClose={close} wide>
      <div className="flex h-full flex-col">
        <div className="flex items-center gap-2 border-b border-line px-3 py-2.5">
          <button type="button" aria-label="Back to projects" disabled={submitting} className="p-1 text-dim hover:bg-hover hover:text-fg focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-45" onClick={back}>
            <Icon icon="chevron-left" size={16} />
          </button>
          <h2 className="min-w-0 flex-1 text-sm font-medium">Add project</h2>
          <button type="button" aria-label="Close project picker" disabled={submitting} className="p-1 text-dim hover:bg-hover hover:text-fg focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-45" onClick={close}>
            <Icon icon="x" size={14} />
          </button>
        </div>
        <div className="grid grid-cols-2 border-b border-line p-2 text-xs">
          <button type="button" aria-pressed={mode === 'folder'} disabled={submitting} className={`px-3 py-2 focus-visible:outline-2 focus-visible:outline-accent ${mode === 'folder' ? 'bg-hover text-fg' : 'text-dim hover:text-fg'}`} onClick={() => { setMode('folder'); setError(null) }}>
            Folder on server
          </button>
          <button type="button" aria-pressed={mode === 'clone'} disabled={submitting} className={`px-3 py-2 focus-visible:outline-2 focus-visible:outline-accent ${mode === 'clone' ? 'bg-hover text-fg' : 'text-dim hover:text-fg'}`} onClick={() => { setMode('clone'); setError(null) }}>
            Clone Git repository
          </button>
        </div>
        {mode === 'folder' ? <>
          <form className="mx-3 flex items-center gap-2 border-b border-line focus-within:border-accent" onSubmit={submitPath}>
            <Icon icon="folder" size={16} className="shrink-0 text-dim" />
            <input
              aria-label="Server folder path"
              className="min-w-0 flex-1 bg-transparent py-3 text-xs outline-none placeholder:text-dim"
              placeholder="Absolute path on the Anvil server"
              value={path}
              disabled={submitting}
              onChange={(event) => setPath(event.target.value)}
              onKeyDown={(event) => { if (event.key === 'Enter') submitPath() }}
            />
            <button type="submit" disabled={loading || submitting || !path.trim()} className="px-2 py-1 text-xs text-accent hover:bg-hover focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-45">
              Open
            </button>
          </form>
          <div role="group" aria-label="Server folders" className="min-h-0 flex-1 overflow-y-auto p-2">
            {listing?.parentPath && <button type="button" disabled={loading || submitting} className="mb-1 flex w-full items-center gap-3 px-3 py-2.5 text-left text-xs hover:bg-hover focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-45" onClick={() => void browse(listing.parentPath!)}>
              <Icon icon="chevron-up" size={16} className="text-dim" />
              <span>Parent folder</span>
            </button>}
            {listing?.directories.map((directory) => <button key={directory.path} type="button" disabled={loading || submitting} className="mb-1 flex w-full items-center gap-3 px-3 py-2.5 text-left text-xs hover:bg-hover focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-45" onClick={() => void browse(directory.path)}>
              <Icon icon="folder" size={16} className="shrink-0 text-dim" />
              <span className="truncate">{directory.name}</span>
            </button>)}
            {loading && <p role="status" className="px-3 py-6 text-center text-xs text-dim">Loading server folders…</p>}
            {!loading && listing && !listing.directories.length && <p role="status" className="px-3 py-6 text-center text-xs text-dim">This folder has no subfolders.</p>}
          </div>
          <div className="border-t border-line p-3">
            {error && <p role="alert" className="pb-2 text-xs text-danger">{error}</p>}
            <button type="button" disabled={!listing || loading || submitting} className="w-full bg-accent px-3 py-2 text-xs font-medium text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-45" onClick={() => { if (listing) void run(() => onAdd(listing.path)) }}>
              {submitting ? 'Adding project…' : 'Add this folder'}
            </button>
          </div>
        </> : <form className="flex min-h-0 flex-1 flex-col p-4" onSubmit={submitClone}>
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
            onKeyDown={(event) => { if (event.key === 'Enter') submitClone() }}
          />
          <p className="mt-3 text-xs leading-5 text-dim">The server will clone this repository into the active workspace. Git credentials must be available on the server.</p>
          <div className="mt-auto">
            {error && <p role="alert" className="pb-2 text-xs text-danger">{error}</p>}
            <button type="submit" disabled={submitting || !url.trim()} className="w-full bg-accent px-3 py-2 text-xs font-medium text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-45">
              {submitting ? 'Cloning repository…' : 'Clone repository'}
            </button>
          </div>
        </form>}
      </div>
    </PickerDialog>
  )
}

export function ProjectPicker({ anchorRef, projects, value, onChange, onAdd, onClone, onClose, onBusyChange }: {
  anchorRef: RefObject<HTMLButtonElement | null>
  projects: Project[]
  value: string | null
  onChange: (id: string) => void
  onAdd: (path: string) => Promise<Project | null>
  onClone: (url: string) => Promise<Project | null>
  onClose: () => void
  onBusyChange: (busy: boolean) => void
}): JSX.Element {
  const [view, setView] = useState<'projects' | 'add'>('projects')

  if (view === 'add') return <AddProjectDialog anchorRef={anchorRef} onAdd={onAdd} onClone={onClone} onBack={() => setView('projects')} onClose={onClose} onBusyChange={onBusyChange} />

  return <ChoicePickerDialog
    anchorRef={anchorRef}
    label="Choose project"
    noun="projects"
    value={value ?? ''}
    choices={projects.map((project) => ({
      id: project.id,
      label: project.name,
      description: project.path,
      icon: <Icon icon="folder" size={16} className="shrink-0 text-dim" />
    }))}
    footer={<div className="border-t border-line p-2">
      <button
        type="button"
        className="flex w-full items-center gap-3 px-3 py-3 text-left text-xs hover:bg-hover focus-visible:outline-2 focus-visible:outline-accent"
        onClick={() => setView('add')}
      >
        <Icon icon="folder-plus" size={16} />
        Add project
      </button>
    </div>}
    onClose={onClose}
    onSelect={(id) => { onClose(); onChange(id) }}
  />
}
