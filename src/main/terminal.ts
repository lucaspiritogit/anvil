import { spawn as ptySpawn, type IPty } from 'node-pty'
import { existsSync } from 'node:fs'
import { delimiter, join } from 'node:path'

export interface TerminalHandlers {
  onData: (id: string, data: string) => void
  onExit: (id: string, code: number) => void
}

function defaultShell(): string {
  if (process.platform !== 'win32') return process.env.SHELL || '/bin/bash'

  for (const dir of (process.env.PATH ?? '').split(delimiter).filter(Boolean)) {
    const pwsh = join(dir, 'pwsh.exe')
    if (existsSync(pwsh)) return pwsh
  }
  return process.env.COMSPEC || 'powershell.exe'
}

export class TerminalManager {
  private terms = new Map<string, IPty>()

  constructor(private handlers: TerminalHandlers) {}

  has(id: string): boolean {
    return this.terms.has(id)
  }

  create(id: string, cwd: string, cols = 80, rows = 24): void {
    if (this.terms.has(id)) return

    const term = ptySpawn(defaultShell(), [], {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: existsSync(cwd) ? cwd : process.cwd(),
      env: { ...process.env } as Record<string, string>
    })

    term.onData((data) => this.handlers.onData(id, data))
    term.onExit(({ exitCode }) => {
      this.terms.delete(id)
      this.handlers.onExit(id, exitCode)
    })

    this.terms.set(id, term)
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

  dispose(id: string): void {
    const term = this.terms.get(id)
    if (!term) return
    this.terms.delete(id)
    try {
      term.kill()
    } catch {
    }
  }

  disposeAll(): void {
    for (const id of [...this.terms.keys()]) this.dispose(id)
  }
}
