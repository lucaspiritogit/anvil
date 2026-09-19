import { useEffect, useState, type JSX } from 'react'
import { GhosttyTerminal } from './GhosttyTerminal'
import { TerminalCommandInput } from './TerminalCommandInput'

export function RightSidePanel({ projectId, visible, onClose }: {
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
    setSessionId(null)
    setError(false)
    setExitCode(null)
    void window.anvil.terminals.create({ projectId, cols: 100, rows: 32 }).then((session) => {
      id = session.sessionId
      if (cancelled) void window.anvil.terminals.dispose(id).catch(() => {})
      else setSessionId(id)
    }).catch(() => { if (!cancelled) setError(true) })
    return () => {
      cancelled = true
      if (id) void window.anvil.terminals.dispose(id).catch(() => {})
    }
  }, [projectId])

  return <section
    aria-label="Project terminal"
    hidden={!visible}
    className="z-10 flex h-full min-h-0 w-[clamp(340px,32vw,480px)] shrink-0 flex-col border-l border-line bg-canvas p-2 max-[1000px]:absolute max-[1000px]:inset-y-0 max-[1000px]:right-0 max-[1000px]:shadow-[-12px_0_28px_rgba(0,0,0,0.28)] max-[700px]:w-full"
  >
    <div className="mb-1 flex shrink-0 items-center justify-between text-xs text-dim">
      <span>Project terminal{exitCode !== null && ` · Exited (${exitCode})`}</span>
      <button onClick={onClose} aria-label="Close project terminal">Close</button>
    </div>
    {error ? <p role="alert">Could not open the project terminal. Close the panel and try again.</p>
      : sessionId ? <div className="flex min-h-0 flex-1 flex-col gap-1">
        <GhosttyTerminal key={sessionId} sessionId={sessionId} visible={visible} className="min-h-0 flex-1" onExit={setExitCode} />
        <div className="hidden shrink-0 [@media(pointer:coarse)]:block">
          <TerminalCommandInput key={sessionId} sessionId={sessionId} disabled={exitCode !== null} />
        </div>
      </div>
        : <p role="status">Starting terminal…</p>}
  </section>
}
