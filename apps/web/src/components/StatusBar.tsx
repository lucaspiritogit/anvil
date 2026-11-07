import type { JSX } from 'react'
import { Icon } from '../icons'
import { cn } from '../ui'
import type { TerminalDockSummary } from './TerminalDock'

export function StatusBar({ projectName, terminalOpen, terminal, onToggleTerminal }: {
  projectName: string
  terminalOpen: boolean
  terminal: TerminalDockSummary | null
  onToggleTerminal(): void
}): JSX.Element {
  const exit = terminal?.exit
  return (
    <footer aria-label="Status bar"
      className="relative z-10 flex h-6 shrink-0 items-center gap-1 border-t border-line bg-canvas px-1.5 font-mono text-[11px] text-dim select-none">
      <span className="flex min-w-0 items-center gap-1.5 px-1.5" title="Active project">
        <span aria-hidden="true" className="text-faint">~</span>
        <span className="truncate">{projectName}</span>
      </span>
      <span className="flex-1" />
      <button type="button" aria-label={terminalOpen ? 'Hide project terminal' : 'Open project terminal'} aria-pressed={terminalOpen}
        title={terminalOpen ? 'Hide terminal (Ctrl+`)' : 'Open terminal (Ctrl+`)'} onClick={onToggleTerminal}
        className={cn('flex h-5 shrink-0 items-center gap-1.5 px-2 hover:bg-hover hover:text-fg focus-visible:outline focus-visible:-outline-offset-1 focus-visible:outline-accent',
          terminalOpen && 'bg-hover text-fg')}>
        <Icon icon="terminal" size={12} aria-hidden="true" />
        <span>terminal</span>
        {terminal && <>
          <span aria-hidden="true" className="text-faint">·</span>
          <span>{terminal.sessions} {terminal.sessions === 1 ? 'session' : 'sessions'}</span>
          {exit !== undefined && <span className={exit === 0 ? 'text-faint' : 'text-danger-text'}>· {exit === 0 ? 'exited' : `✕ exit ${exit}`}</span>}
        </>}
        <span aria-hidden="true" className="text-faint max-[700px]:hidden">⌃`</span>
      </button>
    </footer>
  )
}
