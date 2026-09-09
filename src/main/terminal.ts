import { spawn as ptySpawn, type IPty } from 'node-pty'
import { existsSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { userInfo } from 'node:os'
import { closeProcessTree } from './process-tree'
import type { TerminalSnapshot } from '../shared/types'

export interface ManagedTerminalCommand {
  command: string
  args: string[]
  environment: NodeJS.ProcessEnv
}

export interface TerminalHandlers {
  onData: (id: string, data: string, sequence: number) => void
  onExit: (id: string, code: number) => void
}

function defaultShell(): string {
  if (process.platform !== 'win32') return process.env.SHELL || userInfo().shell || '/bin/sh'

  for (const dir of (process.env.PATH ?? '').split(delimiter).filter(Boolean)) {
    const pwsh = join(dir, 'pwsh.exe')
    if (existsSync(pwsh)) return pwsh
  }
  return process.env.COMSPEC || 'powershell.exe'
}

export class TerminalManager {
  private terms = new Map<string, IPty>()
  private exits = new Map<IPty, Promise<void>>()
  private retiring = new Set<Promise<void>>()
  private shutdown?: Promise<void>
  private history = new Map<string, TerminalSnapshot>()

  constructor(private handlers: TerminalHandlers) {}

  has(id: string): boolean {
    return this.terms.has(id)
  }

  create(id: string, cwd: string, cols = 80, rows = 24, managed?: ManagedTerminalCommand): void {
    if (this.shutdown) throw new Error('Terminals are shutting down')
    if (this.terms.has(id)) return

    const term = ptySpawn(managed?.command ?? defaultShell(), managed?.args ?? (process.platform === 'win32' ? [] : ['-l']), {
      name: 'xterm-256color',
      cols,
      rows,
      cwd,
      env: { ...(managed?.environment ?? process.env), PWD: cwd } as Record<string, string>
    })

    this.exits.set(term, new Promise<void>((resolve) => { term.onExit(() => resolve()) }))
    this.terms.set(id, term)
    this.history.set(id, { data: '', sequence: 0 })
    term.onData((data) => {
      if (this.terms.get(id) !== term) return
      const previous = this.history.get(id)!
      const snapshot = { data: (previous.data + data).slice(-200_000), sequence: previous.sequence + 1 }
      this.history.set(id, snapshot)
      this.handlers.onData(id, data, snapshot.sequence)
    })
    term.onExit(({ exitCode }) => {
      this.exits.delete(term)
      if (this.terms.get(id) !== term) return
      this.terms.delete(id)
      this.history.delete(id)
      this.handlers.onExit(id, exitCode)
    })
  }

  snapshot(id: string): TerminalSnapshot {
    return this.history.get(id) ?? { data: '', sequence: 0 }
  }

  write(id: string, data: string): void {
    this.terms.get(id)?.write(data)
  }

  resize(id: string, cols: number, rows: number): void {
    try {
      this.terms.get(id)?.resize(Math.max(cols, 1), Math.max(rows, 1))
    } catch {
    }
  }

  dispose(id: string): Promise<void> {
    const term = this.terms.get(id)
    if (!term) return Promise.resolve()
    this.terms.delete(id)
    this.history.delete(id)
    const closed = this.exits.get(term) ?? Promise.resolve()
    const retiring = closeProcessTree(term.pid, closed, (force) => {
      try { term.kill(force ? 'SIGKILL' : 'SIGHUP') } catch { /* PTY may already be closed. */ }
    })
    this.retiring.add(retiring)
    void retiring.then(() => this.retiring.delete(retiring), (error) => {
      console.warn('Could not close terminal:', error)
    })
    return retiring
  }

  close(): Promise<void> {
    if (this.shutdown) return this.shutdown
    this.shutdown = Promise.resolve().then(async () => {
      this.disposeAll()
      const results = await Promise.allSettled(this.retiring)
      const errors = results.filter((result) => result.status === 'rejected').map((result) => result.reason)
      if (errors.length) throw new AggregateError(errors, 'Could not close terminals')
    })
    return this.shutdown
  }

  disposeAll(): void {
    for (const id of [...this.terms.keys()]) this.dispose(id)
  }
}
