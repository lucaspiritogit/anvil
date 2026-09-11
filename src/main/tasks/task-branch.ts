import type { Task } from '../../shared/types'
import type { TaskContext } from './context'
import { withTaskOperation } from './operations'
import { renameChildBranchReferences } from './task-stacks'

// Reserved for new task checkouts. Titles/prompts must never enter this name.
const temporaryPrefix = 'anvil-tmp/'
export function temporaryTaskBranch(taskId: string): string {
  return `${temporaryPrefix}${taskId}`
}

export function taskBranchNaming(task: Task): { branchName: string | null; canNameBranch: boolean } {
  return {
    branchName: task.branchName ?? null,
    canNameBranch: task.branchName === temporaryTaskBranch(task.id) && available(task)
  }
}

function available(task: Task): boolean {
  return task.status === 'running' && task.deliveryStatus === 'working' &&
    task.settledAt === undefined && !task.restackState && !!task.baseCommit
}

/** One name selected by the executing agent, using only its connection identity. */
export class TaskBranches {
  private readonly pending = new Map<string, Promise<unknown>>()

  constructor(private readonly context: Pick<TaskContext, 'store' | 'gitDelivery' | 'send'>) {}

  async set(taskId: string, workspaceId: string, proposedName: string, checkTurn: () => void): Promise<ReturnType<typeof taskBranchNaming>> {
    if (typeof proposedName !== 'string' || !proposedName.trim() || proposedName !== proposedName.trim()) throw new Error('Branch name must be a non-empty literal string')
    if (proposedName.startsWith(temporaryPrefix)) throw new Error('Choose a descriptive name outside the reserved temporary branch namespace')
    // Serialize even identical retries, so each caller rechecks its own turn.
    const previous = this.pending.get(taskId)
    const operation = (async () => {
      await previous?.catch(() => {})
      checkTurn()
      const { store, gitDelivery, send } = this.context
      return withTaskOperation(store, taskId, 'branch', async (checkTask) => {
        const check = (): Task => {
          checkTurn()
          const task = checkTask()
          if (task.workspaceId !== workspaceId) throw new Error('Task not found in the owning workspace')
          if (!available(task)) throw new Error('Task branch naming is unavailable')
          if (task.branchName !== temporaryTaskBranch(taskId) && task.branchName !== proposedName) throw new Error('An established task branch cannot be renamed')
          return task
        }
        const original = check()
        const project = store.getProjects(workspaceId).find((item) => item.id === original.projectId)
        if (!project) throw new Error('Project not found in the owning workspace')
        let updates: Task[] = []
        await gitDelivery.renameTaskBranch(project.path, taskId, original.branchName!, proposedName, check, (branchName) => {
          // Git has already changed. Even an expired/cancelled turn must finish
          // reconciliation; never resurrect a deleted task or replace its status.
          updates = store.transaction(() => {
            const current = store.getTask(taskId)
            if (!current) throw new Error('Task was deleted')
            if (current.workspaceId !== workspaceId || current.projectId !== original.projectId ||
              current.branchName !== original.branchName && current.branchName !== branchName) throw new Error('Task branch ownership changed')
            const task = store.updateTask(taskId, { branchName })
            if (!task) throw new Error('Task was deleted')
            return [task, ...renameChildBranchReferences(store, original, branchName)]
          }, workspaceId)
        })
        // Notifications happen after commit and cannot turn a saved rename into
        // a rollback. A later plan read also exposes the persisted name.
        for (const task of updates) {
          try { send('task:updated', task) } catch (error) { console.warn('Could not publish task branch update:', error) }
        }
        return taskBranchNaming(store.getTask(taskId)!)
      })
    })()
    this.pending.set(taskId, operation)
    try { return await operation }
    finally { if (this.pending.get(taskId) === operation) this.pending.delete(taskId) }
  }
}
