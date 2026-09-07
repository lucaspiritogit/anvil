import { ipcMain } from 'electron'
import { randomUUID } from 'node:crypto'
import { getAgent } from '../agents/registry'
import { planningPrompt } from '../agents/task-prompts'
import type { TaskMemory } from '../memory/task-memory'
import type { TaskContext } from '../tasks/context'
import type { TaskEvents } from '../tasks/events'
import type { TaskExecution } from '../tasks/task-execution'
import { titleFor } from '../tasks/task-title'
import type { Task, TaskDiff, ThinkingLevel } from '../../shared/types'

interface TaskHandlerDependencies extends TaskContext, TaskEvents, TaskExecution {
  promptWithProjectMemory: TaskMemory['promptWithProjectMemory']
}

export function registerTaskHandlers({
  store, agentProcesses, gitDelivery, send, recordSystemEvent, forgetUsage,
  initializeTask, stopTask, finishTaskTurn, requireFinishedTask, promptWithProjectMemory
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
    requireFinishedTask(taskId)
    const task = store.settleTask(taskId)
    send('task:updated', task)
    return task
  })
  ipcMain.handle('tasks:delete', (_event, taskId: string): void => {
    if (typeof taskId !== 'string' || !taskId.trim()) throw new Error('A task ID is required')
    // Release only this process's claim; the independent Valence records survive deletion.
    stopTask(taskId, 'Anvil task deleted.')
    // Remove before cancellation so late callbacks cannot restore Anvil metadata.
    store.deleteTaskCascade(taskId)
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
    async (_event, input: { projectId: string; agentId: string; prompt: string; model?: string; thinkingLevel?: ThinkingLevel }) => {
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
      const requireRunningTask = (): void => {
        const current = store.getTask(task.id)
        if (!current) throw new Error('Task was deleted')
        if (current.status !== 'running') throw new Error('Task stopped during preparation')
      }
      try {
        initializeTask(task.id, project.path)
        const prompt = planningPrompt(await promptWithProjectMemory(project.id, input.prompt), task.id, project.path)
        requireRunningTask()

        // Without Git there is no worktree or diff. Run directly in the project folder.
        const git = await gitDelivery.status(project.path)
        requireRunningTask()
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
              thinkingLevel: input.thinkingLevel,
              cwd: project.path,
              projectPath: project.path
            })
          })
          return unmanagedTask
        }

        const prepared = await gitDelivery.prepare(project.path, task.id, task.title)
        requireRunningTask()
        const preparedTask = store.updateTask(task.id, {
          cwd: prepared.cwd,
          deliveryStatus: 'working',
          baseBranch: prepared.baseBranch,
          branchName: prepared.branchName,
          baseCommit: prepared.baseCommit,
          worktreePath: prepared.worktreePath
        })!
        recordSystemEvent(task.id, `Task worktree: ${prepared.worktreePath}\nBranch: ${prepared.branchName}\nStarting snapshot: ${prepared.baseCommit}`)
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
            thinkingLevel: input.thinkingLevel,
            cwd: prepared.cwd,
            projectPath: project.path
          })
        })
        return preparedTask
      } catch (error) {
        const current = store.getTask(task.id)
        if (!current) throw new Error('Task was deleted')
        if (current.status !== 'running') return current
        const message = error instanceof Error ? error.message : String(error)
        const failed = store.updateTask(task.id, {
          status: 'failed',
          endedAt: Date.now(),
          exitCode: null,
          error: message,
          deliveryStatus: 'failed',
          deliveryError: message
        })!
        recordSystemEvent(task.id, `Could not start task: ${message}`, 'delivery', 'error')
        stopTask(task.id, message)
        return failed
      }
    }
  )

  ipcMain.handle('tasks:cancel', (_event, taskId: string) => {
    if (agentProcesses.isRunning(taskId)) return agentProcesses.cancel(taskId)
    // Cancellation must also cover the gap between sequential agent processes.
    const state = store.getTaskExecution(taskId)
    if (!state || state.phase === 'complete' || store.getTask(taskId)?.status !== 'running') return false
    void finishTaskTurn({ taskId, code: null, cancelled: true })
    return true
  })
}
