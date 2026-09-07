import { spawn, type ChildProcess } from 'node:child_process'

/** Wait for pipe closure, escalating if the server or an inherited tool ignores termination. */
export async function closeAgentServer(child: ChildProcess, closed: Promise<void>): Promise<void> {
  killAgentServer(child)
  const forceKill = setTimeout(() => killAgentServer(child, true), 1_000)
  try {
    await closed
  } finally {
    clearTimeout(forceKill)
    // A tool can ignore SIGTERM without inheriting the server's pipes.
    if (process.platform !== 'win32') killAgentServer(child, true)
  }
}

/** Server processes must be spawned detached on POSIX so their tools share a killable group. */
export function killAgentServer(child: ChildProcess, force = false): void {
  if (!child.pid) return
  if (process.platform === 'win32') {
    const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true })
    killer.on('error', () => { child.kill() })
  } else {
    try {
      // Kill the group even if its leader exited while a tool still holds its pipes.
      process.kill(-child.pid, force ? 'SIGKILL' : 'SIGTERM')
    } catch {
      if (child.exitCode === null && child.signalCode === null) child.kill(force ? 'SIGKILL' : 'SIGTERM')
    }
  }
}
