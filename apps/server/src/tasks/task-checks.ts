import { spawn, execFile, type ChildProcess } from 'node:child_process'
import type { Task, TaskChecks } from '@anvil/protocol/types'
import { isLocalQuickTask } from '@anvil/protocol/task-checkout'
import type { RecordSystemEvent, TaskContext } from './context'

const OUTPUT_LIMIT = 64 * 1024
export const CHECKS_TIMEOUT_MS = 15 * 60 * 1000

export interface TaskChecksRunner {
  run(taskId: string): Promise<Task>
  runIfConfigured(taskId: string): void
  cancel(taskId: string): void
  close(): void
}

function killTree(child: ChildProcess): void {
  if (child.pid === undefined || child.exitCode !== null) return
  if (process.platform === 'win32') {
    execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {})
    return
  }
  try { process.kill(-child.pid, 'SIGKILL') } catch {
    try { child.kill('SIGKILL') } catch {}
  }
}

function tail(output: string): string {
  return output.length > OUTPUT_LIMIT ? output.slice(output.length - OUTPUT_LIMIT) : output
}

export function createTaskChecks(
  { store, send }: Pick<TaskContext, 'store' | 'send'>,
  recordSystemEvent: RecordSystemEvent,
  timeoutMs = CHECKS_TIMEOUT_MS,
  onFinished?: (task: Task) => void
): TaskChecksRunner {
  const running = new Map<string, ChildProcess>()

  const save = (taskId: string, checks: TaskChecks): Task | undefined => {
    const task = store.updateTask(taskId, { checks })
    if (task) send('task:updated', task)
    return task
  }

  const run: TaskChecksRunner['run'] = async (taskId) => {
    const task = store.getTask(taskId)
    if (!task) throw new Error('Task not found')
    const project = store.getProjects(task.workspaceId).find((item) => item.id === task.projectId)
    if (!project) throw new Error('Checks need a project')
    const command = project.checkCommand?.trim()
    if (!command) throw new Error('Set a check command for this project in Settings → Source control first.')
    if (task.status === 'running') throw new Error('Wait for the agent to finish before running checks.')
    const cwd = isLocalQuickTask(task) ? project.path : task.cwd
    running.get(taskId)?.removeAllListeners('close')
    const previous = running.get(taskId)
    if (previous) killTree(previous)

    const startedAt = Date.now()
    const headCommit = task.headCommit
    const started = save(taskId, { status: 'running', command, ...(headCommit ? { headCommit } : {}), startedAt, output: '' })
    if (!started) throw new Error('Task was deleted')

    const child = spawn(command, {
      cwd,
      shell: true,
      env: { ...process.env, CI: process.env.CI ?? '1', FORCE_COLOR: '0' },
      windowsHide: true,
      detached: process.platform !== 'win32'
    })
    running.set(taskId, child)
    let output = ''
    const append = (chunk: Buffer): void => { output = tail(output + chunk.toString('utf8')) }
    child.stdout?.on('data', append)
    child.stderr?.on('data', append)
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      killTree(child)
    }, timeoutMs)
    timer.unref()

    return new Promise<Task>((resolve) => {
      const finish = (exitCode: number | null, failure?: string): void => {
        clearTimeout(timer)
        if (running.get(taskId) !== child) {
          resolve(store.getTask(taskId) ?? started)
          return
        }
        running.delete(taskId)
        const passed = exitCode === 0 && !timedOut && !failure
        const note = timedOut ? `\nStopped after ${Math.round(timeoutMs / 60000)} minutes.` : failure ? `\n${failure}` : ''
        const checks: TaskChecks = {
          status: passed ? 'passed' : 'failed',
          command,
          ...(headCommit ? { headCommit } : {}),
          startedAt,
          finishedAt: Date.now(),
          exitCode,
          output: tail(output + note)
        }
        const updated = save(taskId, checks)
        if (updated) {
          recordSystemEvent(taskId, passed
            ? `Checks passed: ${command}`
            : `Checks failed${timedOut ? ' (timed out)' : exitCode === null ? '' : ` with exit code ${exitCode}`}: ${command}`,
          passed ? undefined : 'delivery', passed ? undefined : 'error')
          onFinished?.(updated)
        }
        resolve(updated ?? started)
      }
      child.once('error', (error) => finish(null, error.message))
      child.once('close', (code) => finish(code))
    })
  }

  return {
    run,
    runIfConfigured(taskId) {
      const task = store.getTask(taskId)
      const project = task && store.getProjects(task.workspaceId).find((item) => item.id === task.projectId)
      if (!task || !project?.checkCommand?.trim() || task.deliveryStatus !== 'reviewable') return
      if (task.checks && task.checks.status !== 'running' && task.checks.headCommit === task.headCommit && task.headCommit) return
      void run(taskId).catch((error: unknown) => {
        recordSystemEvent(taskId, `Could not run checks: ${error instanceof Error ? error.message : String(error)}`, 'delivery', 'error')
      })
    },
    cancel(taskId) {
      const child = running.get(taskId)
      if (!child) return
      running.delete(taskId)
      killTree(child)
    },
    close() {
      for (const child of running.values()) killTree(child)
      running.clear()
    }
  }
}
