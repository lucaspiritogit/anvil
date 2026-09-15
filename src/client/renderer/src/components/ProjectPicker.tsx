import type { JSX, RefObject } from 'react'
import { useState } from 'react'
import type { Project } from '@shared/types'
import { Icon } from '../icons'
import { ChoicePickerDialog } from './ChoicePickerDialog'

export function ProjectPicker({ anchorRef, projects, value, onChange, onAdd, onClose, onBusyChange }: {
  anchorRef: RefObject<HTMLButtonElement | null>
  projects: Project[]
  value: string | null
  onChange: (id: string) => void
  onAdd: () => Promise<Project | null>
  onClose: () => void
  onBusyChange: (busy: boolean) => void
}): JSX.Element {
  const [adding, setAdding] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const add = async (): Promise<void> => {
    if (adding) return
    setAdding(true)
    setError(null)
    onBusyChange(true)
    try {
      const project = await onAdd()
      if (project) onClose()
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error))
    } finally {
      setAdding(false)
      onBusyChange(false)
    }
  }

  return <ChoicePickerDialog
    anchorRef={anchorRef}
    label="Choose project"
    noun="projects"
    value={value ?? ''}
    choices={projects.map((project) => ({
      id: project.id,
      label: project.name,
      description: project.path,
      icon: <Icon icon="folder" size={16} className="shrink-0 text-dim" aria-hidden="true" />
    }))}
    footer={<div className="border-t border-line p-2">
      {error && <p role="alert" className="px-3 pb-2 text-xs text-danger">{error}</p>}
      <button
        type="button"
        disabled={adding}
        className="flex w-full items-center gap-3 px-3 py-3 text-left text-xs hover:bg-hover focus-visible:outline-2 focus-visible:outline-accent disabled:cursor-wait disabled:opacity-45"
        onClick={() => void add()}
      >
        <Icon icon={adding ? 'loader' : 'folder-plus'} size={16} className={adding ? 'animate-spin' : undefined} aria-hidden="true" />
        {adding ? 'Adding project…' : 'Add project'}
      </button>
    </div>}
    onClose={onClose}
    onSelect={(id) => { onClose(); onChange(id) }}
  />
}
