import { useEffect, useId, useRef, useState, type JSX } from 'react'
import { flushSync } from 'react-dom'
import { HugeiconsIcon } from '@hugeicons/react'
import { ArrowDown01Icon, Folder01Icon } from '@hugeicons/core-free-icons'
import { MAX_WORKSPACE_NAME_LENGTH, type Workspace } from '@shared/types'
import { useStore } from '../state/store'
import { btn, cn, field, modal } from '../ui'

function WorkspaceNameDialog({ workspace, onClose, onCreated }: {
  workspace: Workspace | null
  onClose: () => void
  onCreated: () => void
}): JSX.Element {
  const id = useId()
  const dialog = useRef<HTMLDialogElement>(null)
  const submitting = useRef(false)
  const [name, setName] = useState(workspace?.name ?? '')
  const [error, setError] = useState('')
  const [pending, setPending] = useState(false)
  const workspaces = useStore((state) => state.workspaces)
  const normalized = name.normalize('NFKC').trim().replace(/\s+/gu, ' ')
  const validation = !normalized ? 'Enter a workspace name.'
    : normalized.length > MAX_WORKSPACE_NAME_LENGTH || /[\p{Cc}\p{Cf}]/u.test(name)
      ? `Use up to ${MAX_WORKSPACE_NAME_LENGTH} characters without control characters.`
      : workspaces.some((item) => item.id !== workspace?.id && item.name.toLowerCase() === normalized.toLowerCase())
        ? 'A workspace with that name already exists.' : ''

  useEffect(() => {
    dialog.current?.showModal()
    return () => dialog.current?.close()
  }, [])

  const submit = async (): Promise<void> => {
    if (submitting.current) return
    if (validation) { setError(validation); return }
    submitting.current = true
    setPending(true)
    setError('')
    try {
      if (workspace) await useStore.getState().renameWorkspace(workspace.id, normalized)
      else await useStore.getState().createWorkspace(normalized)
      onClose()
      if (!workspace) onCreated()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not save workspace. Try again.')
    } finally {
      submitting.current = false
      setPending(false)
    }
  }

  return <dialog ref={dialog} aria-labelledby={`${id}-title`} aria-describedby={workspace ? undefined : `${id}-description`}
    className={cn(modal.panel, modal.width.narrow, 'm-auto text-fg backdrop:bg-black/55')}
    onKeyDown={(event) => {
      event.stopPropagation()
      if (event.key !== 'Tab') return
      const controls = event.currentTarget.querySelectorAll<HTMLElement>('input:not(:disabled), button:not(:disabled)')
      const first = controls[0]
      const last = controls[controls.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last?.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first?.focus()
      }
    }}
    onCancel={(event) => { event.preventDefault(); if (!submitting.current) onClose() }}>
    <form onSubmit={(event) => { event.preventDefault(); void submit() }} aria-busy={pending}>
      <h2 id={`${id}-title`} className={modal.title}>{workspace ? 'Rename workspace' : 'Create workspace'}</h2>
      {!workspace && <p id={`${id}-description`} className={modal.copy}>Start with default settings and signed-out agents. Set up your accounts after creating the workspace.</p>}
      <label className={field.wrap} htmlFor={`${id}-name`}>
        <span className={field.label}>Workspace name</span>
        <input id={`${id}-name`} autoFocus autoComplete="off" className={field.sized} value={name} disabled={pending}
          aria-invalid={Boolean(error)} aria-describedby={error ? `${id}-error` : undefined}
          onChange={(event) => { setName(event.target.value); setError('') }} />
      </label>
      {error && <p id={`${id}-error`} role="alert" className="text-xs text-danger">{error}</p>}
      <div className={cn(modal.actions, 'justify-end')}>
        <button type="button" className={btn.ghost} disabled={pending} onClick={onClose}>Cancel</button>
        <button type="submit" className={btn.primary} disabled={pending}>{pending ? 'Saving…' : workspace ? 'Save name' : 'Create workspace'}</button>
      </div>
    </form>
  </dialog>
}

export function WorkspacePicker(): JSX.Element {
  const id = useId()
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const restoringFocus = useRef(false)
  const selecting = useRef(false)
  const workspaces = useStore((state) => state.workspaces)
  const value = useStore((state) => state.activeWorkspaceId)
  const switching = useStore((state) => state.workspaceSwitching)
  const collapsed = useStore((state) => state.sidebarCollapsed)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [highlight, setHighlight] = useState(0)
  const [editing, setEditing] = useState<Workspace | 'create' | null>(null)
  const selected = workspaces.find((workspace) => workspace.id === value)
  const options = workspaces.filter((workspace) => workspace.name.toLowerCase().includes(query.trim().toLowerCase()))
  const activeIndex = Math.min(highlight, options.length - 1)

  useEffect(() => {
    if (open) listRef.current?.querySelectorAll('[role="option"]')[activeIndex]?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex, open, query])
  useEffect(() => { setOpen(false); setQuery(''); setEditing(null) }, [collapsed])
  useEffect(() => { setOpen(false); setQuery('') }, [value])

  const close = (): void => { setOpen(false); setQuery('') }
  const restoreFocus = (): void => {
    restoringFocus.current = true
    inputRef.current?.focus()
    restoringFocus.current = false
  }
  const show = (): void => {
    if (open || restoringFocus.current || switching || editing) return
    setQuery('')
    setHighlight(Math.max(0, workspaces.findIndex((workspace) => workspace.id === value)))
    setOpen(true)
  }
  const choose = async (workspaceId: string): Promise<void> => {
    if (selecting.current || switching) return
    selecting.current = true
    close()
    try {
      if (workspaceId !== value) await useStore.getState().selectWorkspace(workspaceId)
    } finally {
      selecting.current = false
      // Commit the new composer and remove inert before returning keyboard focus.
      flushSync(close)
      restoreFocus()
    }
  }
  const edit = (mode: 'create' | 'rename'): void => { close(); setEditing(mode === 'create' ? 'create' : selected ?? null) }
  const closeDialog = (): void => { flushSync(() => setEditing(null)); restoreFocus() }

  return <div className="relative min-w-0 flex-1" onBlur={(event) => {
    if (!event.currentTarget.contains(event.relatedTarget)) close()
  }} onKeyDown={(event) => {
    if (open && event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      close()
      restoreFocus()
    }
  }}>
    <label htmlFor={id} className="mb-1 block text-[11px] text-dim">Workspace</label>
    <div className="flex h-9 items-center gap-2 border border-line px-2.5 focus-within:border-accent">
      <HugeiconsIcon icon={Folder01Icon} size={16} className="shrink-0 text-dim" aria-hidden="true" />
      <input id={id} ref={inputRef} role="combobox" aria-autocomplete="list" aria-expanded={open}
        aria-controls={open ? `${id}-list` : undefined}
        aria-activedescendant={open && activeIndex >= 0 ? `${id}-option-${activeIndex}` : undefined}
        aria-description={`Selected workspace: ${selected?.name ?? 'Loading'}`}
        autoComplete="off" placeholder={selected?.name} title={selected?.name}
        value={open ? query : selected?.name ?? ''}
        onFocus={show} onClick={show}
        onChange={(event) => { setQuery(event.target.value); setHighlight(0); setOpen(true) }}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault()
            if (!open) show()
            else setHighlight(Math.max(0, Math.min(options.length - 1, activeIndex + (event.key === 'ArrowDown' ? 1 : -1))))
          } else if (open && (event.key === 'Home' || event.key === 'End')) {
            event.preventDefault()
            setHighlight(event.key === 'Home' ? 0 : Math.max(0, options.length - 1))
          } else if (event.key === 'Enter') {
            event.preventDefault()
            if (!open) show()
            else if (options[activeIndex]) void choose(options[activeIndex].id)
          } else if (open && event.key === 'Escape') {
            event.preventDefault()
            event.stopPropagation()
            close()
          }
        }}
        className="w-full min-w-0 bg-transparent text-xs text-fg placeholder:text-dim outline-none"
      />
      <HugeiconsIcon icon={ArrowDown01Icon} size={14} className="pointer-events-none shrink-0 text-dim" aria-hidden="true" />
    </div>
    {open && <div className="absolute inset-x-0 bottom-full z-30 mb-1 max-h-[65vh] overflow-y-auto border border-line bg-raised shadow-lg">
      <div ref={listRef} id={`${id}-list`} role="listbox" aria-label="Workspaces" className="max-h-[min(320px,40vh)] overflow-y-auto overscroll-contain p-1">
        {options.map((workspace, index) => <div key={workspace.id} id={`${id}-option-${index}`} role="option"
          aria-selected={workspace.id === value} title={workspace.name}
          onMouseDown={(event) => event.preventDefault()} onClick={() => void choose(workspace.id)}
          onMouseMove={() => setHighlight(index)}
          className={cn('min-w-0 cursor-pointer px-2 py-2 text-xs', index === activeIndex && 'bg-hover', workspace.id === value ? 'text-accent' : 'text-fg')}>
          <div className="truncate font-medium">{workspace.name}</div>
          {workspace.id === value && <div className="mt-0.5 text-[10px] text-dim">Selected workspace</div>}
        </div>)}
      </div>
      {!options.length && <p role="status" className="px-3 py-2 text-xs text-dim">No workspaces match your search.</p>}
      <div className="border-t border-line p-1">
        <button className="block w-full px-2 py-2 text-left text-xs hover:bg-hover focus-visible:outline focus-visible:outline-accent" onClick={() => edit('create')}>Create workspace</button>
        <button className="block w-full px-2 py-2 text-left text-xs hover:bg-hover focus-visible:outline focus-visible:outline-accent" onClick={() => edit('rename')}>Rename workspace</button>
      </div>
    </div>}
    {editing && <WorkspaceNameDialog workspace={editing === 'create' ? null : editing} onClose={closeDialog}
      onCreated={() => useStore.setState({ settingsOpen: true, settingsSection: 'providers' })} />}
  </div>
}
