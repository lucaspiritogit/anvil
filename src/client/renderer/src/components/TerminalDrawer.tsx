import { useEffect, useState, type JSX } from 'react'
import { GhosttyTerminal } from './GhosttyTerminal'
import { TerminalCommandInput } from './TerminalCommandInput'

export function TerminalDrawer({ projectId, visible, onClose }: {
  projectId: string
  visible: boolean
  onClose(): void
}): JSX.Element {
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [error, setError] = useState(false)
  const [exitCode, setExitCode] = useState<number | null>(null)
  useEffect(() => {
    let cancelled = false
    let id: string | undefined
    void window.anvil.terminals.create({ projectId, cols: 100, rows: 12 }).then((session) => {
      id = session.sessionId
      if (cancelled) void window.anvil.terminals.dispose(id).catch(() => {})
      else setSessionId(id)
    }).catch(() => { if (!cancelled) setError(true) })
    return () => {
      cancelled = true
      if (id) void window.anvil.terminals.dispose(id).catch(() => {})
    }
  }, [projectId])
  return <section aria-label="Project terminal" hidden={!visible} className="h-60 shrink-0 border-t border-line bg-canvas p-2">
    <div className="mb-1 flex items-center justify-between text-xs text-dim">
      <span>Project terminal{exitCode !== null && ` · Exited (${exitCode})`}</span>
      <button onClick={onClose} aria-label="Close project terminal">Close</button>
    </div>
    {error ? <p role="alert">Could not open the project terminal. Close the panel and try again.</p>
      : sessionId ? <div className="flex h-[calc(100%-24px)] min-h-0 flex-col gap-1">
        <GhosttyTerminal sessionId={sessionId} visible={visible} className="min-h-0 flex-1" onExit={setExitCode} />
        <div className="hidden shrink-0 [@media(pointer:coarse)]:block">
          <TerminalCommandInput key={sessionId} sessionId={sessionId} disabled={exitCode !== null} />
        </div>
      </div>
        : <p role="status">Starting terminal…</p>}
  </section>
}
