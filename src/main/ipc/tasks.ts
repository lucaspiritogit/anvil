import { promptWithFileReferences, validateTaskFileReferences } from '../task-file-references'
import { validateTaskImages } from '../task-images'
import type { RendererIpc } from '../renderer-security'
import { randomUUID } from 'node:crypto'
import { getAgent } from '../agents/registry'
import { planningPrompt } from '../agents/task-prompts'
import type { TaskMemory } from '../memory/task-memory'
import type { TaskContext } from '../tasks/context'
import type { TaskEvents } from '../tasks/events'
import type { TaskExecution } from '../tasks/task-execution'
import { cancelTaskOperation } from '../tasks/operations'
import { TaskIssues } from '../tasks/task-issues'
import { titleFor } from '../tasks/task-title'
import type { Task, TaskDiff, TaskIssueSnapshot } from '../../shared/types'

interface TaskHandlerDependencies extends TaskContext, TaskEvents, TaskExecution {
  promptWithProjectMemory: TaskMemory['promptWithProjectMemory']
}

export function registerTaskHandlers(ipc: RendererIpc, {
  store, agentProcesses, gitDelivery, send, recordSystemEvent, forgetUsage,
  initializeTask, stopTask, finishTaskTurn, requireFinishedTask, promptWithProjectMemory
}: TaskHandlerDependencies): void {
  // Retry cleanup for tasks that settled before the app last closed.
  for (const task of store.getTasks()) {
    if (task.settledAt !== undefined) void gitDelivery.releaseWorktree(task.id)
  }
  const settleDueTasks = (): void => {
    for (const task of store.settleDueTasks()) {
      void gitDelivery.releaseWorktree(task.id)
      send('task:updated', task)
    }
  }
  const settlementTimer = setInterval(settleDueTasks, 60_000)
  settlementTimer.unref()

  ipc.handle('tasks:list', () => {
    settleDueTasks()
    return store.getTasks()
  })
  ipc.handle('tasks:settle', (_event, taskId: string): Task => {
    requireFinishedTask(taskId)
    const task = store.settleTask(taskId)
    void gitDelivery.releaseWorktree(taskId)
    send('task:updated', task)
    return task
  })
  ipc.handle('tasks:delete', (_event, taskId: string): void => {
    cancelTaskOperation(store, taskId)
    // Release only this process's claim; the independent Valence records survive deletion.
    stopTask(taskId, 'Anvil task deleted.')
    // Remove before cancellation so late callbacks cannot restore Anvil metadata.
    store.deleteTaskCascade(taskId)
    forgetUsage(taskId)
    if (agentProcesses.isRunning(taskId)) agentProcesses.cancel(taskId)
    else void gitDelivery.releaseWorktree(taskId)
  })
  const issues = new TaskIssues(store)
  ipc.handle('tasks:issues', (_event, taskId: string): TaskIssueSnapshot | null => issues.snapshot(taskId))
  ipc.handle('tasks:events', (_event, taskId: string) => store.readEvents(taskId))
  ipc.handle('tasks:diff', async (_event, taskId: string): Promise<TaskDiff> => {
    const task = store.getTask(taskId)
    if (!task?.baseCommit || !task.headCommit) throw new Error('This task has no delivered code')
    const project = store.getProjects().find((item) => item.id === task.projectId)
    if (!project) throw new Error('Project not found')
    return gitDelivery.getDiff(project.path, task.baseCommit, task.headCommit)
  })

  ipc.handle('tasks:issue-diff', async (_event, input): Promise<TaskDiff> => {
    if (!store.getTask(input.taskId)) throw new Error('Task not found')
    const project = store.getProjects().find((item) => item.id === store.getTask(input.taskId)!.projectId)
    if (!project) throw new Error('Project not found')
    const source = issues.issueDiffSource(input.taskId, input.issueId)
    const diff = await gitDelivery.getIssueDiff(project.path, source)
    if (!diff) throw new Error('This sub-task has no recorded code changes yet')
    return diff
  })

  ipc.handle(
    'tasks:start',
    async (_event, input) => {
      const workspaceId = store.getActiveWorkspace().id
      // Decode before task/Valence/worktree creation. Text-only calls keep their synchronous preparation.
      const images = input.images?.length ? await validateTaskImages(input.images) : undefined
      const project = store.getProjects().find((project) => project.id === input.projectId)
      if (!project) throw new Error('Project not found')

      if (input.fileReferences?.length) {
        await validateTaskFileReferences(project.path, input.fileReferences)
        if (!store.getProjects().some((item) => item.id === project.id && item.path === project.path)) throw new Error('Project changed')
      }
      const taskPrompt = promptWithFileReferences(input.prompt, project.path, input.fileReferences ?? [])
      const agent = getAgent(input.agentId)
      if (!agent) throw new Error(`Unknown agent: ${input.agentId}`)

      if (images?.length && !['acp', 'codex-app-server'].includes(agent.executionProtocol ?? '')) {
        throw new Error(`${agent.label} does not support image attachments. Choose Codex or OpenCode with an image-capable model.`)
      }
      const model = input.model || agent.defaultModel

      const task: Task = {
        id: randomUUID(),
        workspaceId,
        projectId: project.id,
        agentId: agent.id,
        agentLabel: agent.label,
        model,
        prompt: taskPrompt,
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
        if (images?.length) store.taskImages.save(task.id, images)
        const state = initializeTask(task.id, project.path, { reasoningEffort: input.reasoningEffort, ...(images?.length ? { hasImages: true } : {}) })
        const prompt = planningPrompt(await promptWithProjectMemory(project.id, taskPrompt, task.workspaceId), state)
        requireRunningTask()

        // Without Git there is no task branch or diff. Run directly in the project folder.
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
              images,
              model,
              reasoningEffort: input.reasoningEffort,
              cwd: project.path,
              projectPath: project.path
            })
          })
          return unmanagedTask
        }

        const prepared = await gitDelivery.prepareBranch(project.path, task.id, task.title, requireRunningTask)
        const preparedTask = store.updateTask(task.id, {
          cwd: prepared.cwd,
          ...(store.getTask(task.id)?.status === 'running' ? { deliveryStatus: 'working' as const } : {}),
          baseBranch: prepared.baseBranch,
          branchName: prepared.branchName,
          baseCommit: prepared.baseCommit
        })!
        requireRunningTask()
        recordSystemEvent(task.id, `Task checkout: ${prepared.cwd}\nBranch: ${prepared.branchName}\nStarting commit: ${prepared.baseCommit}`)
        if (prepared.initializedRepository) {
          recordSystemEvent(task.id, 'Created the repository initial commit.')
        }
        setImmediate(() => {
          if (store.getTask(task.id)?.status !== 'running') return
          agentProcesses.start({
            taskId: task.id,
            agent,
            prompt,
            images,
            model,
            reasoningEffort: input.reasoningEffort,
            cwd: prepared.cwd,
            projectPath: project.path
          })
        })
        return preparedTask
      } catch (error) {
        store.taskImages.remove(task.id)
        const current = store.getTask(task.id)
        if (!current) {
          await gitDelivery.releaseWorktree(task.id)
          throw new Error('Task was deleted')
        }
        if (current.status !== 'running') return current
        const message = error instanceof Error ? error.message : String(error)
        const failed = store.updateTask(task.id, {
          status: 'pending',
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

  ipc.handle('tasks:cancel', (_event, taskId: string) => {
    const cancelledOperation = cancelTaskOperation(store, taskId)
    if (agentProcesses.isRunning(taskId)) {
      store.taskImages.remove(taskId)
      recordSystemEvent(taskId, 'Stop requested by user.')
      return agentProcesses.cancel(taskId)
    }
    // Cancellation must also cover the gap between sequential agent processes.
    const state = store.getTaskExecution(taskId)
    if (!state || state.phase === 'complete' || store.getTask(taskId)?.status !== 'running') return cancelledOperation
    store.taskImages.remove(taskId)
    recordSystemEvent(taskId, 'Stop requested by user.')
    void finishTaskTurn({ taskId, code: null, cancelled: true })
    return true
  })
}
