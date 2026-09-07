import type { ExitInfo } from '../agents/process-manager'
import type { TaskMemory } from '../memory/task-memory'
import type { RecordSystemEvent, TaskContext } from './context'

export function createTaskCompletion(
  { store, gitDelivery, send }: Pick<TaskContext, 'store' | 'gitDelivery' | 'send'>,
  recordSystemEvent: RecordSystemEvent,
  { rememberCompletedTask }: Pick<TaskMemory, 'rememberCompletedTask'>
): (info: ExitInfo) => Promise<void> {
  return async (info) => {
    const status = info.cancelled ? 'cancelled' : info.code === 0 ? 'succeeded' : 'failed'
    // Tasks without Git have no worktree to finalize and keep 'unavailable'.
    const existing = store.getTask(info.taskId)
    const managed = Boolean(existing?.worktreePath && existing.baseCommit)
    let task = store.updateTask(info.taskId, {
      status,
      endedAt: Date.now(),
      exitCode: info.code,
      error: info.error,
      ...(managed ? { deliveryStatus: 'finalizing' as const } : {})
    })
    if (task) send('task:updated', task)
    if (task && status === 'failed') {
      recordSystemEvent(task.id, `Task failed: ${info.error ?? 'Agent failed.'}`, 'delivery', 'error')
    }
    const project = store.getProjects().find((item) => item.id === task?.projectId)
    if (!project || !task) return
    if (!managed || !task.worktreePath || !task.baseCommit) {
      await rememberCompletedTask(task, project.path)
      return
    }

    try {
      const successful = status === 'succeeded'
      let markedDidNotCommit = false
      const delivery = await gitDelivery.finalize(
        project.path,
        task.worktreePath,
        task.baseCommit,
        task.title,
        {
          onFinisherCommand: successful
            ? (command: string) => {
              if (!markedDidNotCommit) {
                markedDidNotCommit = true
                const pending = store.updateTask(info.taskId, {
                  deliveryStatus: 'did_not_commit'
                })
                if (pending) send('task:updated', pending)
              }
              recordSystemEvent(info.taskId, command, 'did_not_commit')
            }
            : (command: string) => recordSystemEvent(info.taskId, command, 'delivery')
        }
      )
      task = store.updateTask(task.id, {
        deliveryStatus: successful
          ? delivery.hasChanges
            ? 'reviewable'
            : 'no_changes'
          : 'agent_failed',
        headCommit: delivery.headCommit,
        ...(delivery.branchName ? { branchName: delivery.branchName } : {}),
        filesChanged: delivery.filesChanged,
        additions: delivery.additions,
        deletions: delivery.deletions,
        ...(successful ? {} : { deliveryError: info.error ?? 'The agent did not exit successfully.' })
      })
      if (delivery.cleanupWarning) {
        recordSystemEvent(task?.id ?? info.taskId, `Worktree cleanup warning: ${delivery.cleanupWarning}`)
      }
      if (task) send('task:updated', task)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      task = store.updateTask(info.taskId, { deliveryStatus: 'failed', deliveryError: message })
      recordSystemEvent(info.taskId, `Git delivery failed: ${message}`, 'delivery', 'error')
      if (task) send('task:updated', task)
    }

    if (task) await rememberCompletedTask(task, project.path)
  }
}
