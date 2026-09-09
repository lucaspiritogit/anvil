import type { JSX } from 'react'
import { useEffect, useRef, useState } from 'react'
import { useStore } from '../state/store'
import { IS_MAC, isTerminalShortcut } from '../keys'
import { cn } from '../ui'
import { TerminalPane } from './TerminalPane'

export function ProjectTerminal(): JSX.Element | null {
  const projects = useStore((state) => state.projects)
  const settingsOpen = useStore((state) => state.settingsOpen)
  const [opened, setOpened] = useState<string[]>([])
  const [active, setActive] = useState<string | null>(null)
  const restoreFocus = useRef<HTMLElement | null>(null)
  const dialogRef = useRef<HTMLDivElement>(null)
  const project = projects.find((item) => item.id === active)

  // Settings navigation must be visible even when a terminal was open.
  // Shell sessions stay mounted and can be reopened with the terminal shortcut.
  useEffect(() => { setActive(null) }, [settingsOpen])

  const close = (): void => {
    setActive(null)
    if (restoreFocus.current?.isConnected) restoreFocus.current.focus()
  }

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (isTerminalShortcut(event)) {
        event.preventDefault()
        event.stopImmediatePropagation()
        if (event.repeat) return
        if (project) { close(); return }
        const state = useStore.getState()
        const id = state.activeProjectId ?? state.projects[0]?.id
        if (!id) return
        restoreFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
        setOpened((ids) => ids.includes(id) ? ids : [...ids, id])
        setActive(id)
      } else if (project && event.key === 'Escape') {
        event.preventDefault()
        event.stopImmediatePropagation()
        close()
      } else if (project && event.key === 'Tab') {
        // Keep keyboard navigation in the overlay. Tab inside xterm still reaches the shell.
        const dialog = dialogRef.current
        if (!dialog) return
        const controls = [...dialog.querySelectorAll<HTMLElement>('button, textarea')].filter((element) => element.offsetParent !== null)
        const first = controls[0]
        const last = controls.at(-1)
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault()
          last?.focus()
        } else if (!dialog.contains(document.activeElement)) {
          event.preventDefault()
          first?.focus()
        }
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [project])

  if (!opened.length) return null
  return (
    <div className={cn('fixed inset-0 z-[100] bg-black/65 p-5 backdrop-blur-sm max-sm:p-2', !project && 'hidden')}
      onMouseDown={(event) => { if (event.target === event.currentTarget) close() }}>
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-label="Project terminal"
        className="flex h-full w-full min-h-0 flex-col overflow-hidden rounded-lg border border-line bg-[#0d0f12] shadow-[0_24px_100px_rgba(0,0,0,0.7)]">
        <header className="flex shrink-0 items-center gap-4 border-b border-line px-4 py-3 text-fg">
          <div className="min-w-0 flex-1">
            <h2 className="text-sm font-medium">{project?.name} terminal</h2>
            <p className="truncate text-xs text-dim" title={project?.path}>{project?.path}</p>
          </div>
          <span className="text-xs text-dim">{IS_MAC ? '⌘T' : 'Ctrl+T'}</span>
          <button className="rounded px-2 py-1 text-sm hover:bg-hover focus-visible:outline-2 focus-visible:outline-accent" aria-label="Close terminal" onClick={close}>Close</button>
        </header>
        {opened.filter((id) => projects.some((item) => item.id === id)).map((id) => (
          <div key={id} className={cn('min-h-0 flex-1', id !== active && 'hidden')}>
            <TerminalPane projectId={id} visible={id === active && Boolean(project)} />
          </div>
        ))}
      </div>
    </div>
  )
}
