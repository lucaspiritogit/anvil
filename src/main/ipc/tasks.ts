import { ipcMain } from 'electron'
import { randomUUID } from 'node:crypto'
import { getAgent } from '../agents/registry'
import { issueTrackerPrompt } from '../issue-tracker'
import type { TaskMemory } from '../memory/task-memory'
import type { TaskContext } from '../tasks/context'
import type { TaskEvents } from '../tasks/events'
import type { IssueExecution } from '../tasks/issue-execution'
import { titleFor } from '../tasks/task-title'
import type { Task, TaskDiff } from '../../shared/types'

interface TaskHandlerDependencies extends TaskContext, TaskEvents, IssueExecution {
  promptWithProjectMemory: TaskMemory['promptWithProjectMemory']
}

export function registerTaskHandlers({
  store, agentProcesses, gitDelivery, send, recordSystemEvent, forgetUsage,
  publishIssueTracker, finishIssueTracker, requireFinishedTracker, promptWithProjectMemory
}: TaskHandlerDependencies): void {
  const settleDueTasks = (): void => {
    for (const task of store.settleDueTasks()) send('task:updated', task)
  }
  const settlementTimer = setInterval(settleDueTasks, 60_000)
  settlementTimer.unref()

  ipcMain.handle('tasks:list', () => {
    settleDueTasks()
    return store.getTasks()
  })
  ipcMain.handle('tasks:settle', (_event, taskId: string): Task => {
    requireFinishedTracker(taskId)
    const task = store.settleTask(taskId)
    send('task:updated', task)
    return task
  })
  ipcMain.handle('tasks:delete', (_event, taskId: string): void => {
    if (typeof taskId !== 'string' || !taskId.trim()) throw new Error('A task ID is required')
    // Remove first so cancellation and late async callbacks cannot persist more output/issues.
    store.removeTask(taskId)
    forgetUsage(taskId)
    if (agentProcesses.isRunning(taskId)) agentProcesses.cancel(taskId)
  })
  ipcMain.handle('tasks:events', (_event, taskId: string) => store.readEvents(taskId))
  ipcMain.handle('tasks:diff', async (_event, taskId: string): Promise<TaskDiff> => {
    const task = store.getTask(taskId)
    if (!task?.baseCommit || !task.headCommit) throw new Error('This task has no delivered code')
    const project = store.getProjects().find((item) => item.id === task.projectId)
    if (!project) throw new Error('Project not found')
    return gitDelivery.getDiff(project.path, task.baseCommit, task.headCommit)
  })

  ipcMain.handle(
    'tasks:start',
    async (_event, input: { projectId: string; agentId: string; prompt: string; model?: string }) => {
      const project = store.getProjects().find((project) => project.id === input.projectId)
      if (!project) throw new Error('Project not found')

      const agent = getAgent(input.agentId)
      if (!agent) throw new Error(`Unknown agent: ${input.agentId}`)

      const model = input.model || agent.defaultModel

      const task: Task = {
        id: randomUUID(),
        projectId: project.id,
        agentId: agent.id,
        agentLabel: agent.label,
        model,
        prompt: input.prompt,
        title: titleFor(input.prompt),
        cwd: project.path,
        status: 'running',
        startedAt: Date.now(),
        exitCode: null,
        inputTokens: 0,
        outputTokens: 0,
        cachedTokens: 0,
        totalTokens: 0,
        costUsd: null,
        deliveryStatus: 'preparing',
        filesChanged: 0,
        additions: 0,
        deletions: 0
      }
      store.addTask(task)
      const tracker = publishIssueTracker({ taskId: task.id, limit: 50, phase: 'planning', items: [], error: null, eventOffset: 0 })
      const prompt = issueTrackerPrompt(tracker, await promptWithProjectMemory(project.id, input.prompt))

      // Without Git there is no worktree or diff. Run directly in the project folder.
      const git = await gitDelivery.status(project.path)
      if (!store.getTask(task.id)) throw new Error('Task was deleted')
      if (!git.isRepository) {
        const unmanagedTask = store.updateTask(task.id, {
          cwd: project.path,
          deliveryStatus: 'unavailable'
        })!
        setImmediate(() => {
          if (store.getTask(task.id)?.status !== 'running') return
          agentProcesses.start({
            taskId: task.id,
            agent,
            prompt,
            model,
            cwd: project.path
          })
        })
        return unmanagedTask
      }

      try {
        const prepared = await gitDelivery.prepare(project.path, task.id, task.title)
        if (!store.getTask(task.id)) throw new Error('Task was deleted')
        const preparedTask = store.updateTask(task.id, {
          cwd: prepared.cwd,
          deliveryStatus: 'working',
          baseBranch: prepared.baseBranch,
          branchName: prepared.branchName,
          baseCommit: prepared.baseCommit,
          worktreePath: prepared.worktreePath
        })!
        if (prepared.initializedRepository) {
          recordSystemEvent(task.id, 'Created the repository initial commit.')
        }
        setImmediate(() => {
          if (store.getTask(task.id)?.status !== 'running') return
          agentProcesses.start({
            taskId: task.id,
            agent,
            prompt,
            model,
            cwd: prepared.cwd
          })
        })
        return preparedTask
      } catch (error) {
        if (!store.getTask(task.id)) throw new Error('Task was deleted')
        const message = error instanceof Error ? error.message : String(error)
        const failed = store.updateTask(task.id, {
          status: 'failed',
          endedAt: Date.now(),
          exitCode: null,
          error: message,
          deliveryStatus: 'failed',
          deliveryError: message
        })!
        recordSystemEvent(task.id, `Could not prepare Git workspace: ${message}`, 'delivery', 'error')
        publishIssueTracker({ ...tracker, phase: 'blocked', error: message })
        return failed
      }
    }
  )

  ipcMain.handle('tasks:cancel', (_event, taskId: string) => {
    if (agentProcesses.isRunning(taskId)) return agentProcesses.cancel(taskId)
    // Cancellation must also cover the gap between sequential agent processes.
    const tracker = store.getIssueTracker(taskId)
    if (!tracker || tracker.phase === 'complete' || store.getTask(taskId)?.status !== 'running') return false
    void finishIssueTracker({ taskId, code: null, cancelled: true })
    return true
  })
}
