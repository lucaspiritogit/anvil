import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/** Capture descendants before terminating their parent, which may orphan them. */
async function descendants(pid: number): Promise<number[]> {
  const { stdout } = await execFileAsync('ps', ['-axo', 'pid=,ppid='], { timeout: 1_000, maxBuffer: 4 * 1024 * 1024 })
  const rows = stdout.trim().split('\n').map((line) => line.trim().split(/\s+/).map(Number))
  const owned = new Set([pid])
  let changed = true
  while (changed) {
    changed = false
    for (const [child, parent] of rows) {
      if (child > 1 && owned.has(parent) && !owned.has(child)) {
        owned.add(child)
        changed = true
      }
    }
  }
  return [...owned].reverse()
}

function forceKill(pids: number[]): void {
  const errors: unknown[] = []
  for (const pid of pids) {
    if (pid <= 1 || pid === process.pid) continue
    // Terminal jobs and detached agent tools can have separate process groups.
    for (const target of [-pid, pid]) {
      try { process.kill(target, 'SIGKILL') } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') errors.push(error)
      }
    }
  }
  if (errors.length) throw new AggregateError(errors, 'Could not kill process tree')
}

/** Give owned processes a grace period, then kill remaining jobs and bound pipe closure. */
export async function closeProcessTree(pid: number | undefined, closed: Promise<void>, terminate: (force: boolean) => void): Promise<void> {
  let pids: number[] = []
  if (pid && process.platform !== 'win32') {
    try { pids = await descendants(pid) } catch (error) {
      console.warn('Could not enumerate process descendants:', error)
      pids = [pid]
    }
  }
  let forced = false
  const force = (): void => {
    if (forced) return
    forced = true
    // The native process/PTY owner can still close handles if enumeration failed.
    try { if (process.platform !== 'win32') forceKill(pids) } finally { terminate(true) }
  }
  let escalation: ReturnType<typeof setTimeout> | undefined
  let deadline: ReturnType<typeof setTimeout> | undefined
  try {
    terminate(false)
    await Promise.race([
      closed,
      new Promise<never>((_, reject) => {
        escalation = setTimeout(() => {
          try { force() } catch (error) { reject(error) }
        }, 1_000)
        deadline = setTimeout(() => reject(new Error(`Process ${pid ?? 'unknown'} did not close after termination`)), 3_000)
      })
    ])
  } finally {
    clearTimeout(escalation)
    clearTimeout(deadline)
    // Jobs may ignore SIGTERM even when the parent has already closed its pipes.
    force()
  }
}
