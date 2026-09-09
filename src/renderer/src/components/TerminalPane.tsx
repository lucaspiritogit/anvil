import type { JSX } from 'react'
import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { DEFAULT_KEYBINDINGS, SHORTCUTS } from '@shared/keybindings'
import { isTerminalShortcut, matchesAccelerator } from '../keys'
import { useStore } from '../state/store'

interface Props {
  projectId: string
  visible: boolean
}

export function TerminalPane({ projectId, visible }: Props): JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)
  const terminalRef = useRef<Terminal | null>(null)
  const [generation, setGeneration] = useState(0)
  const [exited, setExited] = useState(false)

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    setExited(false)
    const term = new Terminal({
      fontFamily: 'Cascadia Mono, Consolas, Menlo, monospace',
      fontSize: 13,
      cursorBlink: true,
      cursorStyle: 'block',
      theme: {
        background: '#0d0f12', foreground: '#d7dbe0', cursor: '#7aa2f7', selectionBackground: '#2a3040'
      }
    })
    terminalRef.current = term
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(host)
    term.attachCustomKeyEventHandler((event) => {
      const keybindings = useStore.getState().settings?.keybindings ?? DEFAULT_KEYBINDINGS
      return !isTerminalShortcut(event) && !SHORTCUTS.some((shortcut) => matchesAccelerator(event, keybindings[shortcut.id]))
    })

    let disposed = false
    let ready = false
    let sequence = 0
    const queued: { data: string; sequence: number }[] = []
    const safeFit = (): void => {
      if (disposed || host.clientWidth === 0 || host.clientHeight === 0) return
      try { fit.fit() } catch { return }
      if (ready) window.anvil.terminal.resize(projectId, term.cols, term.rows)
    }
    const receive = (chunk: { data: string; sequence: number }): void => {
      if (chunk.sequence <= sequence) return
      sequence = chunk.sequence
      term.write(chunk.data)
    }
    // Subscribe before creating the PTY so its first prompt cannot be lost.
    const offData = window.anvil.terminal.onData(({ id, ...chunk }) => {
      if (id !== projectId) return
      if (ready) receive(chunk)
      else queued.push(chunk)
    })
    const offExit = window.anvil.terminal.onExit(({ id, code }) => {
      if (id !== projectId) return
      ready = false
      term.writeln(`\r\n[shell exited with code ${code}]`)
      setExited(true)
    })
    safeFit()
    void window.anvil.terminal.ensure({ projectId, cols: term.cols, rows: term.rows }).then((snapshot) => {
      if (disposed) return
      sequence = snapshot.sequence
      term.write(snapshot.data)
      ready = true
      queued.forEach(receive)
      queued.length = 0
      safeFit()
      if (host.clientWidth > 0) term.focus()
    }).catch((error: unknown) => {
      if (!disposed) {
        term.writeln(`\r\n[Could not start terminal: ${error instanceof Error ? error.message : String(error)}]`)
        setExited(true)
      }
    })
    const inputSub = term.onData((data) => { if (ready) window.anvil.terminal.write(projectId, data) })
    const observer = new ResizeObserver(safeFit)
    observer.observe(host)
    return () => {
      disposed = true
      observer.disconnect()
      inputSub.dispose()
      offData()
      offExit()
      terminalRef.current = null
      term.dispose()
    }
  }, [projectId, generation])

  useEffect(() => {
    if (!visible) return
    const frame = requestAnimationFrame(() => terminalRef.current?.focus())
    return () => cancelAnimationFrame(frame)
  }, [visible])

  return (
    <div className="relative h-full min-h-0">
      <div className="h-full px-3 py-2" ref={hostRef} />
      {exited && <button className="absolute right-4 top-3 border border-line bg-raised px-3 py-1.5 text-xs text-fg hover:bg-hover" onClick={() => setGeneration((value) => value + 1)}>Restart shell</button>}
    </div>
  )
}
