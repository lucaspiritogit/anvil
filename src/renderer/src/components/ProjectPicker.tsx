import type { JSX } from 'react'
import { flushSync } from 'react-dom'
import { useEffect, useId, useRef, useState } from 'react'
import { HugeiconsIcon } from '@hugeicons/react'
import { ArrowDown01Icon, Folder01Icon } from '@hugeicons/core-free-icons'
import type { Project } from '@shared/types'
import { cn } from '../ui'

export function ProjectPicker({ projects, value, onChange }: {
  projects: Project[]
  value: string | null
  onChange: (id: string | null) => void
}): JSX.Element {
  const id = useId()
  const inputRef = useRef<HTMLInputElement>(null)
  const restoringFocus = useRef(false)
  const listRef = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [highlight, setHighlight] = useState(0)
  const selected = projects.find((project) => project.id === value)
  const options = [
    { id: null, name: 'All', path: 'Tasks from all projects' },
    ...projects
  ].filter((project) => `${project.name} ${project.path}`.toLowerCase().includes(query.trim().toLowerCase()))
  const activeIndex = Math.min(highlight, options.length - 1)

  useEffect(() => {
    if (open) listRef.current?.querySelectorAll('[role="option"]')[activeIndex]?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex, open, query])

  const show = (): void => {
    if (open || restoringFocus.current) return
    setQuery('')
    setHighlight(Math.max(0, projects.findIndex((project) => project.id === value) + 1))
    setOpen(true)
  }
  const close = (): void => { setOpen(false); setQuery('') }
  const choose = (projectId: string | null): void => {
    // The new project's composer focuses on mount. Restore the combobox after
    // that render so selection does not move keyboard users out of the sidebar.
    flushSync(() => { onChange(projectId); close() })
    restoringFocus.current = true
    inputRef.current?.focus()
    restoringFocus.current = false
  }

  return (
    <div className="relative min-w-0 flex-1" onBlur={(event) => {
      if (!event.currentTarget.contains(event.relatedTarget)) close()
    }}>
      <label htmlFor={id} className="mb-1 block text-[11px] text-dim">Project</label>
      <div className="flex h-9 items-center gap-2 border border-line px-2.5 focus-within:border-accent">
        <HugeiconsIcon icon={Folder01Icon} size={16} className="shrink-0 text-dim" aria-hidden="true" />
        <input
          id={id}
          ref={inputRef}
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={open}
          aria-controls={open ? `${id}-list` : undefined}
          aria-activedescendant={open && activeIndex >= 0 ? `${id}-option-${activeIndex}` : undefined}
          autoComplete="off"
          placeholder={selected?.name ?? 'All'}
          title={selected?.path ?? 'Tasks from all projects'}
          value={open ? query : selected?.name ?? 'All'}
          onFocus={show}
          onClick={show}
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
              else if (options[activeIndex]) choose(options[activeIndex].id)
            } else if (open && event.key === 'Escape') {
              event.preventDefault()
              event.stopPropagation()
              close()
            } else if (event.key === 'Tab') close()
          }}
          className="w-full min-w-0 bg-transparent text-xs text-fg placeholder:text-dim outline-none"
        />
        <HugeiconsIcon icon={ArrowDown01Icon} size={14} className="pointer-events-none shrink-0 text-dim" aria-hidden="true" />
      </div>
      {open && (
        <div className="absolute inset-x-0 top-full z-30 mt-1 border border-line bg-raised shadow-lg">
          <div ref={listRef} id={`${id}-list`} role="listbox" aria-label="Projects" className="max-h-[min(320px,40vh)] overflow-y-auto overscroll-contain p-1">
            {options.map((project, index) => (
              <div
                key={project.id ?? 'all'}
                id={`${id}-option-${index}`}
                role="option"
                aria-selected={project.id === value}
                title={project.path}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => choose(project.id)}
                onMouseMove={() => setHighlight(index)}
                className={cn('min-w-0 cursor-pointer px-2 py-2 text-xs', index === activeIndex && 'bg-hover', project.id === value ? 'text-accent' : 'text-fg')}
              >
                <div className="truncate font-medium">{project.name}</div>
                <div className="mt-0.5 truncate text-[10px] text-dim">{project.path}</div>
              </div>
            ))}
          </div>
          {!projects.length && <p role="status" className="px-3 py-2 text-xs text-dim">No projects yet. Use Add project to get started.</p>}
          {projects.length > 0 && !options.length && <p role="status" className="px-3 py-2 text-xs text-dim">No projects match your search.</p>}
        </div>
      )}
    </div>
  )
}
