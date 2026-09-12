import { useEffect, useRef, useState, type JSX } from 'react'
import { Ghostty, Terminal, FitAddon } from 'ghostty-web'
import wasmUrl from 'ghostty-web/ghostty-vt.wasm?url'
import type { TerminalOutput } from '@shared/terminal'
import { isTerminalShortcut } from '../keys'
import { attachTerminalInput } from '../terminal-input'

let ghostty: Promise<Ghostty> | undefined
function loadGhostty(): Promise<Ghostty> {
  ghostty ??= Ghostty.load(wasmUrl).catch((error) => { ghostty = undefined; throw error })
  return ghostty
}

export function GhosttyTerminal({ sessionId, className, visible = true, onExit }: {
  sessionId: string
  className?: string
  visible?: boolean
  onExit?: (exitCode: number) => void
}): JSX.Element {
  const host = useRef<HTMLDivElement>(null)
  const terminal = useRef<Terminal | null>(null)
  const exitHandler = useRef(onExit)
  exitHandler.current = onExit
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    let cleanup = (): void => {}
    setError(null)
    void (async () => {
      const engine = await loadGhostty()
      if (cancelled || !host.current) return
      const colors = getComputedStyle(host.current)
      const color = (name: string): string => colors.getPropertyValue(`--color-${name}`).trim()
      const term = new Terminal({ ghostty: engine, fontSize: 13, theme: {
        background: color('canvas'), foreground: color('fg'), cursor: color('accent'), black: color('dim')
      } })
      terminal.current = term
      cleanup = () => { term.dispose(); terminal.current = null }
      const fit = new FitAddon()
      term.loadAddon(fit)
      // ghostty-web 0.4 consumes keys when this handler returns true.
      term.attachCustomKeyEventHandler((event) => isTerminalShortcut(event) || event.key === 'Escape')
      term.open(host.current)
      const reportRequestFailure = (error: unknown): void => {
        if (!cancelled) setError(error instanceof Error ? error.message : 'Terminal request failed')
      }
      const input = term.onData((data) => {
        void window.anvil.terminals.write({ sessionId, data }).catch(reportRequestFailure)
      })
      const detachInput = attachTerminalInput(host.current, term)
      const resize = term.onResize(({ cols, rows }) => {
        void window.anvil.terminals.resize({ sessionId, cols: Math.min(500, Math.max(2, cols)), rows: Math.min(300, Math.max(1, rows)) }).catch(reportRequestFailure)
      })
      let attached = false
      let sequence = 0
      const queued: TerminalOutput[] = []
      const write = (output: TerminalOutput): void => {
        if (output.sequence <= sequence) return
        sequence = output.sequence
        if (output.data) term.write(output.data)
      }
      const offOutput = window.anvil.terminals.onOutput((output) => {
        if (output.sessionId !== sessionId) return
        if (attached) write(output)
        else queued.push(output)
      })
      const offExit = window.anvil.terminals.onExit((event) => {
        if (event.sessionId === sessionId) exitHandler.current?.(event.exitCode)
      })
      const observer = new ResizeObserver(() => {
        if (host.current && host.current.clientHeight > 0) fit.fit()
      })
      observer.observe(host.current)
      cleanup = () => { offOutput(); offExit(); observer.disconnect(); detachInput(); input.dispose(); resize.dispose(); term.dispose(); terminal.current = null }
      const snapshot = await window.anvil.terminals.attach(sessionId)
      if (cancelled) return
      if (snapshot.data) term.write(snapshot.data)
      sequence = snapshot.sequence
      attached = true
      for (const output of queued) write(output)
      if (snapshot.exitCode !== undefined) exitHandler.current?.(snapshot.exitCode)
      fit.fit()
      term.focus()
    })().catch((error) => {
      console.error('Terminal initialization failed', error)
      cleanup()
      if (!cancelled) setError('Could not load the terminal. Close the panel and try again.')
    })
    return () => { cancelled = true; cleanup() }
  }, [sessionId])
  useEffect(() => { if (visible) terminal.current?.focus() }, [visible])
  return <div data-terminal className={className} onKeyDown={(event) => {
    if (event.key === 'Escape') { (document.activeElement as HTMLElement)?.blur(); event.stopPropagation() }
  }}>
    {error && <p role="alert" className="text-xs text-danger">{error}</p>}
    <div ref={host} className="relative h-full w-full overflow-hidden bg-canvas" />
  </div>
}
