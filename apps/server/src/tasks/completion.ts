import type { ExitInfo } from '../agents/process-manager'
import type { TaskMemory } from '../memory/task-memory'
import type { RecordSystemEvent, TaskContext } from './context'
import { taskStyle } from '@anvil/protocol/task-style'
import { usesManagedWorktree } from './checkout'

interface TaskCompletionOptions {
  finalize: boolean
  completedDeliveryStatus?: 'reviewable' | 'no_changes'
  waitForMemory?: boolean
}

export type TaskCompletion = (info: ExitInfo, options?: TaskCompletionOptions) => Promise<void>

export function createTaskCompletion(
  { store, gitDelivery, send }: Pick<TaskContext, 'store' | 'gitDelivery' | 'send'>,
  recordSystemEvent: RecordSystemEvent,
  { rememberCompletedTask }: Pick<TaskMemory, 'rememberCompletedTask'>
): TaskCompletion {
  return async (info, options) => {
    const status = info.cancelled ? 'cancelled' : info.code === 0 ? 'succeeded' : 'pending'
    // Git tasks deliver a final diff from their branch.
    const existing = store.getTask(info.taskId)
    const managed = Boolean(existing && usesManagedWorktree(existing) && existing.baseCommit && existing.branchName)
    const completedDeliveryStatus = status === 'succeeded' ? options?.completedDeliveryStatus : undefined
    let task = store.updateTask(info.taskId, {
      status,
      endedAt: Date.now(),
      exitCode: info.code,
      error: info.error,
      ...(completedDeliveryStatus
        ? { deliveryStatus: completedDeliveryStatus }
        : managed && options?.finalize !== false
          ? { deliveryStatus: 'finalizing' as const }
          : {})
    })
    if (task) send('task:updated', task)
    if (task && status === 'pending') {
      recordSystemEvent(task.id, `Task paused: ${info.error ?? 'Agent failed.'}`, 'delivery', 'error')
    }
    const project = store.getProjects(task?.workspaceId).find((item) => item.id === task?.projectId)
    if (!project || !task) return
    if (taskStyle(task) !== 'work' && !managed) {
      if (status !== 'succeeded') return
      const reviewPaths = [...new Set([...(task.reviewPaths ?? []), ...(info.result?.changedFiles ?? [])])]
      try {
        const diff = await gitDelivery.getWorkingTreeDiff(project.path, reviewPaths)
        task = store.updateTask(task.id, {
          reviewPaths: diff.paths,
          deliveryStatus: diff.patch ? 'reviewable' : 'no_changes',
          filesChanged: diff.filesChanged,
          additions: diff.additions,
          deletions: diff.deletions
        })
        if (task) send('task:updated', task)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        task = store.updateTask(info.taskId, { reviewPaths, deliveryStatus: 'failed', deliveryError: message })
        recordSystemEvent(info.taskId, `Git diff failed: ${message}`, 'delivery', 'error')
        if (task) send('task:updated', task)
      }
      if (task) await rememberCompletedTask(task, project.path)
      return
    }
    if (!managed || !task.baseCommit || options?.finalize === false) {
      if (options?.waitForMemory === false) {
        const completedTask = task
        setImmediate(() => { void rememberCompletedTask(completedTask, project.path) })
        return
      }
      await rememberCompletedTask(task, project.path)
      return
    }

    try {
      const successful = status === 'succeeded'
      let markedDidNotCommit = false
      const delivery = await gitDelivery.finalizeBranch(project.path, task.id, task.branchName!, task.baseBranch, task.baseCommit, task.title, {
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
      })
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
