import { useEffect, useState, type JSX } from 'react'
import { GhosttyTerminal } from './GhosttyTerminal'

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
      : sessionId ? <GhosttyTerminal sessionId={sessionId} visible={visible} className="h-[calc(100%-24px)]" onExit={setExitCode} />
        : <p role="status">Starting terminal…</p>}
  </section>
}
