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
    const hostElement = host.current
    if (!hostElement) return
    let cancelled = false
    let cleanup = (): void => { hostElement.replaceChildren() }
    hostElement.replaceChildren()
    setError(null)
    void (async () => {
      const engine = await loadGhostty()
      if (cancelled || host.current !== hostElement) return
      const colors = getComputedStyle(hostElement)
      const color = (name: string): string => colors.getPropertyValue(`--color-${name}`).trim()
      const term = new Terminal({ ghostty: engine, fontSize: 13, theme: {
        background: color('canvas'), foreground: color('fg'), cursor: color('accent'), black: color('dim')
      } })
      terminal.current = term
      let disposed = false
      const active = (): boolean => !cancelled && !disposed && host.current === hostElement && terminal.current === term
      cleanup = () => {
        if (disposed) return
        disposed = true
        if (terminal.current === term) terminal.current = null
        hostElement.replaceChildren()
        term.dispose()
      }
      const fit = new FitAddon()
      term.loadAddon(fit)
      // ghostty-web 0.4 consumes keys when this handler returns true.
      term.attachCustomKeyEventHandler((event) => isTerminalShortcut(event) || event.key === 'Escape')
      hostElement.replaceChildren()
      term.open(hostElement)
      const reportRequestFailure = (error: unknown): void => {
        if (active()) setError(error instanceof Error ? error.message : 'Terminal request failed')
      }
      const input = term.onData((data) => {
        if (active()) void window.anvil.terminals.write({ sessionId, data }).catch(reportRequestFailure)
      })
      const detachInput = attachTerminalInput(hostElement, term)
      const resize = term.onResize(({ cols, rows }) => {
        if (active()) void window.anvil.terminals.resize({ sessionId, cols: Math.min(500, Math.max(2, cols)), rows: Math.min(300, Math.max(1, rows)) }).catch(reportRequestFailure)
      })
      let fitFrame = 0
      let trailingFitTimer: ReturnType<typeof setTimeout> | undefined
      const fitToHost = (): void => {
        if (!active() || hostElement.clientWidth <= 0 || hostElement.clientHeight <= 0) return
        fit.fit()
      }
      const scheduleFit = (): void => {
        if (!active()) return
        if (fitFrame) cancelAnimationFrame(fitFrame)
        fitFrame = requestAnimationFrame(() => {
          fitFrame = 0
          fitToHost()
        })
        if (trailingFitTimer) clearTimeout(trailingFitTimer)
        // FitAddon ignores resize requests for 50 ms after it changes the grid.
        // Keep a trailing fit so layout changes during that window are not lost.
        trailingFitTimer = setTimeout(() => {
          trailingFitTimer = undefined
          fitToHost()
        }, 100)
      }
      let attached = false
      let sequence = 0
      const queued: TerminalOutput[] = []
      const write = (output: TerminalOutput): void => {
        if (!active() || output.sequence <= sequence) return
        sequence = output.sequence
        if (output.data) term.write(output.data)
      }
      const offOutput = window.anvil.terminals.onOutput((output) => {
        if (!active() || output.sessionId !== sessionId) return
        if (attached) write(output)
        else queued.push(output)
      })
      const offExit = window.anvil.terminals.onExit((event) => {
        if (active() && event.sessionId === sessionId) exitHandler.current?.(event.exitCode)
      })
      const observer = new ResizeObserver(scheduleFit)
      observer.observe(hostElement)
      fitToHost()
      cleanup = () => {
        if (disposed) return
        disposed = true
        if (terminal.current === term) terminal.current = null
        hostElement.replaceChildren()
        offOutput()
        offExit()
        observer.disconnect()
        if (fitFrame) cancelAnimationFrame(fitFrame)
        if (trailingFitTimer) clearTimeout(trailingFitTimer)
        detachInput()
        input.dispose()
        resize.dispose()
        term.dispose()
      }
      const snapshot = await window.anvil.terminals.attach(sessionId)
      if (!active()) return
      if (snapshot.data) term.write(snapshot.data)
      sequence = snapshot.sequence
      attached = true
      for (const output of queued) write(output)
      if (active() && snapshot.exitCode !== undefined) exitHandler.current?.(snapshot.exitCode)
      scheduleFit()
      if (active()) term.focus()
    })().catch((error) => {
      cleanup()
      if (!cancelled) {
        console.error('Terminal initialization failed', error)
        setError('Could not load the terminal. Close the panel and try again.')
      }
    })
    return () => { cancelled = true; cleanup() }
  }, [sessionId])
  useEffect(() => {
    if (!visible) return
    const frame = requestAnimationFrame(() => {
      const term = terminal.current
      if (!term?.renderer || !term.wasmTerm) return
      term.renderer.render(term.wasmTerm, true, term.viewportY, term)
      term.focus()
    })
    return () => cancelAnimationFrame(frame)
  }, [visible])
  return <div data-terminal data-terminal-session={sessionId} className={className} onKeyDown={(event) => {
    if (event.key === 'Escape') { (document.activeElement as HTMLElement)?.blur(); event.stopPropagation() }
  }}>
    {error && <p role="alert" className="text-xs text-danger">{error}</p>}
    <div ref={host} className="relative h-full w-full overflow-hidden bg-canvas" />
  </div>
}
