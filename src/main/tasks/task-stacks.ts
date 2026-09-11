import type { Task, TaskStackTarget } from '../../shared/types'
import type { TaskContext } from './context'
import type { Store } from '../store'
import { taskOperationActive, withTaskOperation } from './operations'

export function requireStackParent(store: Store, task: Pick<Task, 'id' | 'projectId' | 'workspaceId'>, parentId: string): Task {
  const parent = store.getTask(parentId)
  if (!parent || parent.projectId !== task.projectId || parent.workspaceId !== task.workspaceId) throw new Error('Choose a parent task in the same project')
  if (!parent.branchName || !['working', 'reviewable'].includes(parent.deliveryStatus) || parent.settledAt !== undefined || parent.status === 'cancelled' || parent.restackState) {
    throw new Error('The parent must have an active branch with no pending restack')
  }
  const seen = new Set([task.id])
  let current: Task | undefined = parent
  while (current) {
    if (seen.has(current.id)) throw new Error('Task stacks cannot contain cycles')
    seen.add(current.id)
    const id: string | undefined = current.restackTarget?.parentTaskId ?? current.parentTaskId
    current = id ? store.getTask(id) : undefined
  }
  return parent
}

export function requireStackMergeable(store: Store, task: Task): void {
  if (task.restackState) throw new Error('Finish restacking this task before merging')
  if (task.parentTaskId) {
    const parent = store.getTask(task.parentTaskId)
    if (parent && parent.deliveryStatus !== 'approved') throw new Error('Merge the parent task first')
    // A merged parent's child must still go through restacking to refresh its diff.
    throw new Error('Restack this task onto the project branch before merging')
  }
}

export class TaskStacks {
  constructor(private readonly context: TaskContext) {}

  private update(id: string, patch: Partial<Task>): Task {
    const task = this.context.store.updateTask(id, patch)
    if (!task) throw new Error('Task was deleted')
    this.context.send('task:updated', task)
    return task
  }

  async stack(taskId: string, parentId: string): Promise<Task> {
    const { store, gitDelivery } = this.context
    return withTaskOperation(store, taskId, 'stack', async (check) => {
      const task = check()
      if (!task.branchName || !task.baseCommit || task.settledAt !== undefined || !['working', 'reviewable'].includes(task.deliveryStatus) || task.restackState) throw new Error('This task cannot be stacked now')
      const parent = requireStackParent(store, task, parentId)
      const target = await gitDelivery.stackBase(this.project(task), parent.branchName)
      check()
      requireStackParent(store, task, parentId)
      return this.update(taskId, { restackTarget: { ...target, parentTaskId: parentId }, restackState: 'pending', stackSuggestion: undefined })
    }).then(async () => {
      await this.apply(taskId)
      const task = store.getTask(taskId)
      if (!task) throw new Error('Task was deleted')
      if (task.restackState === 'conflict') throw new Error(task.deliveryError ?? 'Restack conflict')
      return task
    })
  }

  private project(task: Task): string {
    const project = this.context.store.getProjects(task.workspaceId).find((item) => item.id === task.projectId)
    if (!project) throw new Error('Project not found')
    return project.path
  }

  /** Persist every request before trying Git. Running children consume it at a turn boundary. */
  async restackChildren(parentId: string, removed = false): Promise<void> {
    const { store, gitDelivery } = this.context
    const parent = store.getTask(parentId)
    if (!parent) return
    const children = store.getTasks(parent.workspaceId).filter((task) => task.parentTaskId === parentId || task.restackTarget?.parentTaskId === parentId)
    if (!children.length) return
    const projectPath = this.project(parent)
    await gitDelivery.withRepoLock(projectPath, async () => {
      const target = await gitDelivery.stackBase(projectPath)
      for (const original of children) {
        const child = store.getTask(original.id)
        if (!child?.baseCommit || child.parentTaskId !== parentId && child.restackTarget?.parentTaskId !== parentId) continue
        const oldBase = removed ? await gitDelivery.commonBase(projectPath, child.baseCommit, target.commit) : child.baseCommit
        this.update(child.id, { parentTaskId: undefined, restackState: 'pending', restackTarget: { ...target, oldBase } })
      }
    })
    for (const child of store.getTasks(parent.workspaceId).filter((task) => task.projectId === parent.projectId && task.restackState === 'pending')) await this.apply(child.id)
  }

  async apply(taskId: string, betweenTurns = false): Promise<void> {
    const { store, agentProcesses, gitDelivery } = this.context
    const task = store.getTask(taskId)
    if (!task?.restackState || !task.restackTarget || taskOperationActive(store, taskId) || agentProcesses.isRunning(taskId) || task.deliveryStatus === 'finalizing' || task.status === 'running' && !betweenTurns && store.getTaskExecution(taskId)?.phase !== 'reviewing') return
    if (task.restackTarget.parentTaskId && store.getTask(task.restackTarget.parentTaskId)?.restackState) return
    await withTaskOperation(store, taskId, 'stack', async (check) => {
      const current = check()
      if (!current.branchName || !current.baseCommit) throw new Error('This task has no branch to restack')
      const target: TaskStackTarget = { ...current.restackTarget! }
      const guard = (): void => {
        check()
        if (agentProcesses.isRunning(taskId)) throw new Error('Wait for the agent to stop before restacking')
        if (target.parentTaskId) requireStackParent(store, current, target.parentTaskId)
      }
      try {
        guard()
        if (target.parentTaskId) Object.assign(target, await gitDelivery.stackBase(this.project(current), store.getTask(target.parentTaskId)!.branchName))
        await gitDelivery.restackBranch(this.project(current), taskId, current.branchName,
          target.oldBase ?? current.baseCommit, target, guard, (result) => {
            // Save the rewritten ranges before releasing the repository lock.
            store.transaction(() => {
              const state = store.getTaskExecution(taskId)
              if (state?.currentIssueId) {
                const tracker = store.issueTracker(current.projectId, current.workspaceId)
                try { tracker.recordCommits(state.currentIssueId, { baseCommit: target.commit, headCommit: result.headCommit }) }
                finally { tracker.close() }
              }
              this.update(taskId, {
                baseCommit: target.commit, baseBranch: target.branch, headCommit: result.headCommit,
                filesChanged: result.filesChanged, additions: result.additions, deletions: result.deletions,
                ...(state?.phase === 'complete' ? { deliveryStatus: result.hasChanges ? 'reviewable' : 'no_changes' } : {}),
                parentTaskId: target.parentTaskId, restackState: undefined, restackTarget: undefined, deliveryError: undefined
              })
              for (const child of store.getTasks(current.workspaceId).filter((entry) => (entry.restackTarget?.parentTaskId ?? entry.parentTaskId) === taskId)) {
                this.update(child.id, { restackState: 'pending', restackTarget: { commit: result.headCommit, branch: current.branchName!, parentTaskId: taskId } })
              }
            }, current.workspaceId)
          })
      } catch (error) {
        if (store.getTask(taskId)) this.update(taskId, { restackState: 'conflict', ...(current.status === 'running' ? { status: 'pending', endedAt: Date.now() } : {}), deliveryError: error instanceof Error ? error.message : String(error) })
      }
    })
    for (const child of store.getTasks(task.workspaceId).filter((entry) => (entry.restackTarget?.parentTaskId ?? entry.parentTaskId) === taskId && entry.restackState === 'pending')) await this.apply(child.id)
  }

  async suggest(taskId: string): Promise<void> {
    const { store, gitDelivery } = this.context
    const task = store.getTask(taskId)
    if (!task || task.parentTaskId || task.restackState || !task.expectedFiles?.length) return
    let best: Task['stackSuggestion']
    for (const candidate of store.getTasks(task.workspaceId)) {
      try { requireStackParent(store, task, candidate.id) } catch { continue }
      let files = candidate.expectedFiles ?? []
      if (candidate.baseCommit && candidate.branchName) {
        try { files = [...files, ...await gitDelivery.changedFiles(this.project(task), candidate.baseCommit, candidate.branchName)] } catch { /* Declared paths still provide a suggestion. */ }
      }
      const paths = task.expectedFiles.filter((path) => files.includes(path))
      if (paths.length && paths.length > (best?.paths.length ?? 0)) best = { parentTaskId: candidate.id, paths }
    }
    if (store.getTask(taskId) && best) this.update(taskId, { stackSuggestion: best })
  }
}
