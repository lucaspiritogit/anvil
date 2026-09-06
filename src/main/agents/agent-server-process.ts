import { spawn, type ChildProcess } from 'node:child_process'

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
