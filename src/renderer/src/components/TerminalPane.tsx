import type { JSX } from 'react'
import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'

interface Props {
  projectId: string
  cwd: string
}

export function TerminalPane({ projectId, cwd }: Props): JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    const term = new Terminal({
      fontFamily: 'Cascadia Mono, Consolas, Menlo, monospace',
      fontSize: 13,
      cursorBlink: true,
      allowProposedApi: true,
      theme: {
        background: '#0d0f12',
        foreground: '#d7dbe0',
        cursor: '#7aa2f7',
        selectionBackground: '#2a3040'
      }
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(host)

    const safeFit = (): void => {
      if (host.clientWidth === 0 || host.clientHeight === 0) return
      try {
        fit.fit()
      } catch {
        return
      }
      window.anvil.terminal.resize(projectId, term.cols, term.rows)
    }

    safeFit()
    void window.anvil.terminal.ensure({
      id: projectId,
      cwd,
      cols: term.cols,
      rows: term.rows
    })

    const offData = window.anvil.terminal.onData(({ id, data }) => {
      if (id === projectId) term.write(data)
    })
    const offExit = window.anvil.terminal.onExit(({ id }) => {
      if (id === projectId) term.writeln('\r\n[shell exited]')
    })

    const inputSub = term.onData((data) => window.anvil.terminal.write(projectId, data))

    const observer = new ResizeObserver(() => safeFit())
    observer.observe(host)

    return () => {
      observer.disconnect()
      inputSub.dispose()
      offData()
      offExit()
      term.dispose()
    }
  }, [projectId, cwd])

  return <div className="h-full pt-2 pr-1 pb-1 pl-2.5" ref={hostRef} />
}
