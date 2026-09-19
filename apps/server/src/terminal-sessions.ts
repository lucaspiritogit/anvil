import { closeProcessTree } from './process-tree'
import { randomUUID } from 'node:crypto'
import { chmodSync, existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { spawn, type IPty } from 'node-pty'
import type { Store } from './store'
import type { TerminalSnapshot } from '@anvil/protocol/terminal'
import type { WorkspaceExecutionContext } from './agents/workspace-execution'
import { openCodeWorkspaceCommand } from './agents/opencode-workspace'
import { resolveCommand } from './agents/resolve'

const requireForNodePty = createRequire(import.meta.url)

export function ensureNodePtySpawnHelperExecutable(options: {
  platform?: NodeJS.Platform
  architecture?: string
  packageDirectory?: string
} = {}): void {
  const platform = options.platform ?? process.platform
  if (platform === 'win32') return
  const architecture = options.architecture ?? process.arch
  const packageDirectory = options.packageDirectory ?? dirname(requireForNodePty.resolve('node-pty/package.json'))
  const helper = [
    join(packageDirectory, 'build', 'Release', 'spawn-helper'),
    join(packageDirectory, 'build', 'Debug', 'spawn-helper'),
    join(packageDirectory, 'prebuilds', `${platform}-${architecture}`, 'spawn-helper')
  ].map((candidate) => candidate
    .replace('app.asar', 'app.asar.unpacked')
    .replace('node_modules.asar', 'node_modules.asar.unpacked'))
    .find(existsSync)
  if (helper) chmodSync(helper, 0o755)
}

interface Session extends TerminalSnapshot {
  pty: IPty
  kind: 'project' | 'auth'
  workspaceId: string
  closed: Promise<void>
  closing?: Promise<void>
  subscriptions: { dispose(): void }[]
}

export class TerminalSessionManager {
  private readonly sessions = new Map<string, Session>()

  constructor(
    private readonly store: Pick<Store, 'getProjects' | 'getActiveWorkspace'>,
    private readonly broadcast: (channel: string, payload: unknown) => void
  ) {}

  createProject(input: { projectId: string; cols: number; rows: number }): { sessionId: string } {
    const project = this.store.getProjects().find((project) => project.id === input.projectId)
    if (!project) throw new Error('Project not found')
    return this.create('project', this.store.getActiveWorkspace().id,
      process.platform === 'win32' ? 'powershell.exe' : process.env.SHELL || '/bin/sh', [],
      project.path, process.env, input.cols, input.rows)
  }

  createOpenCodeAuth(workspace: WorkspaceExecutionContext, logout: boolean, onExit: (exitCode: number) => void): { sessionId: string } {
    const launch = openCodeWorkspaceCommand(workspace, ['auth', logout ? 'logout' : 'login'])
    const resolved = resolveCommand(launch.command)
    if (!resolved || resolved.viaShell) throw new Error('OpenCode requires a directly executable CLI')
    return this.create('auth', workspace.workspaceId, resolved.command, [...resolved.prefixArgs, ...launch.args],
      launch.cwd, launch.environment, 80, 10, onExit)
  }

  createCodexAuth(workspace: WorkspaceExecutionContext, onExit: (exitCode: number) => void): { sessionId: string } {
    const resolved = resolveCommand('codex')
    if (!resolved || resolved.viaShell) throw new Error('Codex requires a directly executable CLI')
    return this.create('auth', workspace.workspaceId, resolved.command,
      [...resolved.prefixArgs, 'login', '--device-auth', '-c', 'cli_auth_credentials_store="file"'],
      workspace.home, workspace.environment, 80, 10, onExit)
  }

  private create(kind: Session['kind'], workspaceId: string, command: string, args: string[], cwd: string,
    environment: NodeJS.ProcessEnv, cols: number, rows: number, onExit?: (code: number) => void): { sessionId: string } {
    const env = Object.fromEntries(Object.entries(environment).filter((entry): entry is [string, string] => entry[1] !== undefined))
    ensureNodePtySpawnHelperExecutable()
    const pty = spawn(command, args, { cwd, env, cols, rows, name: 'xterm-256color' })
    const sessionId = randomUUID()
    let markClosed!: () => void
    const closed = new Promise<void>((resolve) => { markClosed = resolve })
    const session: Session = { pty, kind, workspaceId, data: '', sequence: 0, subscriptions: [], closed }
    this.sessions.set(sessionId, session)
    session.subscriptions.push(pty.onData((data) => {
      session.data = (session.data + data).slice(-1_000_000)
      session.sequence += 1
      this.broadcast('terminals:output', { sessionId, data, sequence: session.sequence })
    }), pty.onExit(({ exitCode }) => {
      markClosed()
      session.exitCode = exitCode
      this.broadcast('terminals:exit', { sessionId, exitCode })
      onExit?.(exitCode)
    }))
    return { sessionId }
  }

  attach(sessionId: string): TerminalSnapshot {
    const session = this.require(sessionId)
    return { data: session.data, sequence: session.sequence, exitCode: session.exitCode }
  }

  private require(sessionId: string): Session {
    const session = this.sessions.get(sessionId)
    if (!session) throw new Error('Terminal session not found')
    return session
  }

  write(sessionId: string, data: string): void {
    const session = this.require(sessionId)
    if (session.exitCode === undefined) session.pty.write(data)
  }

  resize(sessionId: string, cols: number, rows: number): void {
    const session = this.require(sessionId)
    if (session.exitCode === undefined) session.pty.resize(cols, rows)
  }

  dispose(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session) return Promise.resolve()
    if (session.closing) return session.closing
    session.closing = Promise.resolve().then(async () => {
      if (session.exitCode === undefined) {
        await closeProcessTree(session.pty.pid, session.closed, (force) => {
          if (session.exitCode === undefined) session.pty.kill(force ? 'SIGKILL' : undefined)
        })
      }
      for (const subscription of session.subscriptions) subscription.dispose()
      this.sessions.delete(sessionId)
    })
    return session.closing
  }

  async disposeProjects(): Promise<void> {
    await Promise.all([...this.sessions].filter(([, session]) => session.kind === 'project').map(([id]) => this.dispose(id)))
  }

  async disposeAll(): Promise<void> {
    await Promise.all([...this.sessions.keys()].map((id) => this.dispose(id)))
  }
}
