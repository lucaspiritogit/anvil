import { TaskStacks, requireStackParent } from '../tasks/task-stacks'
import { resolveWorkspaceExecution } from '../agents/workspace-execution'
import { promptWithFileReferences, validateTaskFileReferences } from '../task-file-references'
import { validateTaskImages } from '../task-images'
import type { HandlerRegistry } from '../handler-registry'
import { randomUUID } from 'node:crypto'
import { getAgent } from '../agents/registry'
import { registerTaskStarts } from '../tasks/start'
import type { TaskMemory } from '../memory/task-memory'
import type { TaskContext } from '../tasks/context'
import type { TaskEvents } from '../tasks/events'
import type { TaskExecution } from '../tasks/task-execution'
import { withTaskOperation, cancelTaskOperation, taskOperationKind } from '../tasks/operations'
import { TaskIssues } from '../tasks/task-issues'
import { titleFor } from '../tasks/task-title'
import type { Task, TaskDiff, TaskIssueSnapshot, TaskEvent, TaskEventsPage } from '@anvil/protocol/types'
import { taskStyle } from '@anvil/protocol/task-style'
import { requireProjectCheckoutAvailable, usesManagedWorktree } from '../tasks/checkout'

interface TaskHandlerDependencies extends TaskContext, TaskEvents, TaskExecution {
  promptWithProjectMemory: TaskMemory['promptWithProjectMemory']
}

export function registerTaskResultNoticeHandlers(ipc: HandlerRegistry, store: TaskContext['store']): void {
  const requireActiveWorkspace = (workspaceId: string): void => {
    if (workspaceId !== store.getActiveWorkspace().id) throw new Error('Workspace changed. Retry.')
  }
  ipc.handle('task-result-notices:list', ({ workspaceId, projectId }) => {
    requireActiveWorkspace(workspaceId)
    if (projectId !== undefined) {
      if (!store.getProjects(workspaceId).some((project) => project.id === projectId)) throw new Error('Project not found')
      return store.getProjectTaskResultNotices(projectId, workspaceId)
    }
    return store.getTaskResultNotices(workspaceId)
  })
  ipc.handle('task-result-notices:seen', ({ workspaceId, noticeId }) => {
    requireActiveWorkspace(workspaceId)
    return store.markTaskResultNoticeSeen(noticeId, workspaceId)
  })
  ipc.handle('task-result-notices:dismiss', ({ workspaceId, noticeId }) => {
    requireActiveWorkspace(workspaceId)
    return store.dismissTaskResultNotice(noticeId, workspaceId)
  })
}

export function registerTaskHandlers(ipc: HandlerRegistry, {
  store, agentProcesses, gitDelivery, send, recordSystemEvent, forgetUsage,
  issueReviewReady, initializeTask, stopTask, deferTaskCleanup, skipTaskCleanup, finishTaskTurn, requireFinishedTask, promptWithProjectMemory
}: TaskHandlerDependencies): void {
  registerTaskResultNoticeHandlers(ipc, store)
  const stacks = new TaskStacks({ store, agentProcesses, gitDelivery, send })
  const startTask = registerTaskStarts({ store, agentProcesses, gitDelivery, send, recordSystemEvent, stopTask, promptWithProjectMemory })
  ipc.handle('tasks:stack', (input) => stacks.stack(input.taskId, input.parentTaskId))
  ipc.handle('tasks:stack-dismiss', (taskId) => {
    const task = store.updateTask(taskId, { stackSuggestion: undefined })
    if (!task) throw new Error('Task not found')
    send('task:updated', task)
    return task
  })
  ipc.handle('tasks:restack', async (taskId) => {
    await stacks.apply(taskId)
    const task = store.getTask(taskId)
    if (!task) throw new Error('Task not found')
    return task
  })
  for (const task of store.getTasks()) {
    if (task.deliveryStatus === 'approved' || task.deliveryStatus === 'no_changes' || task.status === 'cancelled') void stacks.restackChildren(task.id, task.deliveryStatus !== 'approved').catch(console.warn)
    else if (task.restackState === 'pending') void stacks.apply(task.id).catch(console.warn)
  }
  const detachingChildren = new Set<string>()
  store.subscribeActivity(() => {
    for (const task of store.getTasks()) {
      if (task.restackState === 'pending') void stacks.apply(task.id).catch(console.warn)
      if ((task.deliveryStatus === 'approved' || task.deliveryStatus === 'no_changes') && !detachingChildren.has(task.id) &&
        store.getTasks(task.workspaceId).some((child) => (child.restackTarget?.parentTaskId ?? child.parentTaskId) === task.id)) {
        detachingChildren.add(task.id)
        void stacks.restackChildren(task.id, task.deliveryStatus !== 'approved')
          .catch(console.warn).finally(() => { detachingChildren.delete(task.id) })
      }
    }
  })
  // Retry cleanup for tasks that settled before the app last closed.
  for (const task of store.getTasks()) {
    const project = store.getProjects(task.workspaceId).find((entry) => entry.id === task.projectId)
    if (!usesManagedWorktree(task)) continue
    if (task.settledAt !== undefined && project && task.branchName) {
      void gitDelivery.releaseWorktree(project.path, task.id, task.branchName)
    } else if (task.settledAt !== undefined) void gitDelivery.releaseWorktree(task.id)
  }
  const settleDueTasks = (): void => {
    for (const task of store.settleDueTasks()) {
      const project = store.getProjects(task.workspaceId).find((entry) => entry.id === task.projectId)
      if (usesManagedWorktree(task)) {
        if (project && task.branchName) void gitDelivery.releaseWorktree(project.path, task.id, task.branchName)
        else void gitDelivery.releaseWorktree(task.id)
      }
      send('task:updated', task)
    }
  }
  const settlementTimer = setInterval(settleDueTasks, 60_000)
  settlementTimer.unref()

  ipc.handle('tasks:compact', (taskId) => withTaskOperation(store, taskId, 'compact', async (check) => {
    const task = check()
    if ((task.status === 'running' && !issueReviewReady(taskId)) || task.settledAt !== undefined || task.deliveryStatus === 'finalizing') {
      throw new Error('Wait for the task to stop before compacting')
    }
    const agent = getAgent(task.agentId)
    if (!agent?.supportsCompaction || !task.sessionId) throw new Error('This task has no session that can be compacted')
    const state = store.getTaskExecution(taskId)
    await agentProcesses.compact({
      taskId, agent, workspace: resolveWorkspaceExecution(store, task.workspaceId),
      cwd: task.cwd, model: task.model, reasoningEffort: state?.reasoningEffort,
      issueId: state?.currentIssueId ?? undefined, resumeSessionId: task.sessionId, prompt: '',
      issueTracker: taskStyle(task) === 'work',
      beforeDispatch: () => { check() }
    })
  }))

  ipc.handle('tasks:list', () => {
    settleDueTasks()
    return store.getTasks(store.getActiveWorkspace().id)
  })
  ipc.handle('tasks:settle', (taskId: string): Task => {
    requireFinishedTask(taskId)
    const task = store.settleTask(taskId)
    const project = store.getProjects(task.workspaceId).find((entry) => entry.id === task.projectId)
    if (usesManagedWorktree(task)) {
      if (project && task.branchName) void gitDelivery.releaseWorktree(project.path, task.id, task.branchName)
      else void gitDelivery.releaseWorktree(task.id)
    }
    send('task:updated', task)
    return task
  })
  ipc.handle('tasks:delete', async (taskId: string): Promise<void> => {
    const task = store.getTask(taskId)
    if (task?.deliveryStatus === 'merge_conflict' || task?.mergeConflict) {
      throw new Error('Abort the paused merge before deleting this task')
    }
    if (taskOperationKind(store, taskId) === 'merge') throw new Error('Wait for the merge attempt to finish before deleting this task')
    cancelTaskOperation(store, taskId)
    const deletedTask = store.getTask(taskId)
    const project = deletedTask && store.getProjects(deletedTask.workspaceId).find((entry) => entry.id === deletedTask.projectId)
    if (store.getTasks().some((task) => task.parentTaskId === taskId || task.restackTarget?.parentTaskId === taskId)) {
      stopTask(taskId, 'Anvil task deleted.')
      store.updateTask(taskId, { status: 'cancelled' })
      if (agentProcesses.isRunning(taskId)) agentProcesses.cancel(taskId)
      await stacks.restackChildren(taskId, true)
    }
    // Release only this process's claim; the independent Valence records survive deletion.
    const running = agentProcesses.isRunning(taskId)
    if (running && project && deletedTask?.branchName && usesManagedWorktree(deletedTask)) deferTaskCleanup(taskId, project.path, deletedTask.branchName)
    else if (running && deletedTask && !usesManagedWorktree(deletedTask)) skipTaskCleanup(taskId)
    store.transaction(() => {
      stopTask(taskId, 'Anvil task deleted.')
      // Remove before cancellation so late callbacks cannot restore Anvil metadata.
      store.deleteTaskCascade(taskId)
    }, store.getTask(taskId)?.workspaceId)
    forgetUsage(taskId)
    if (running) agentProcesses.cancel(taskId)
    else if (deletedTask && usesManagedWorktree(deletedTask)) {
      if (project && deletedTask.branchName) void gitDelivery.releaseWorktree(project.path, taskId, deletedTask.branchName)
      else void gitDelivery.releaseWorktree(taskId)
    }
  })
  const issues = new TaskIssues(store)
  ipc.handle('tasks:issues', (taskId: string): TaskIssueSnapshot | null => {
    const snapshot = issues.snapshot(taskId)
    return snapshot && { ...snapshot, reviewReady: issueReviewReady(taskId) }
  })
  ipc.handle('tasks:events', (taskId: string): TaskEvent[] => store.readEvents(taskId))
  ipc.handle('tasks:events-page', (input): TaskEventsPage => store.readEventsPage(input))
  ipc.handle('tasks:diff', async (taskId: string): Promise<TaskDiff> => {
    const task = store.getTask(taskId)
    if (!task) throw new Error('Task not found')
    const project = store.getProjects(task?.workspaceId).find((item) => item.id === task.projectId)
    if (!project) throw new Error('Project not found')
    if (taskStyle(task) === 'quick' && !usesManagedWorktree(task)) {
      if (!task.reviewPaths?.length) throw new Error('This task has no delivered code')
      const { patch, commits } = await gitDelivery.getWorkingTreeDiff(project.path, task.reviewPaths)
      return { patch, commits }
    }
    if (!task.baseCommit || !task.headCommit) throw new Error('This task has no delivered code')
    return gitDelivery.getDiff(project.path, task.baseCommit, task.headCommit)
  })

  ipc.handle('tasks:issue-diff', async (input): Promise<TaskDiff> => {
    const task = store.getTask(input.taskId)
    if (!task) throw new Error('Task not found')
    const project = store.getProjects(task.workspaceId).find((item) => item.id === task.projectId)
    if (!project) throw new Error('Project not found')
    const source = issues.issueDiffSource(input.taskId, input.issueId)
    const state = store.getTaskExecution(input.taskId)
    const issue = issues.list(input.taskId).find((entry) => entry.id === input.issueId)!
    if (!['review', 'complete'].includes(issue.status) ||
      state?.currentIssueId === input.issueId && !issueReviewReady(input.taskId)) {
      throw new Error('This sub-task has not finished preparing its review changes')
    }
    const diff = await gitDelivery.getIssueDiff(project.path, source)
    if (!diff) throw new Error('This sub-task has no recorded code changes yet')
    return diff
  })

  ipc.handle(
    'tasks:start',
    async (input) => {
      const workspaceId = store.getActiveWorkspace().id
      if (input.workspaceId !== undefined && input.workspaceId !== workspaceId) throw new Error('Workspace changed before task creation. Retry.')
      // Decode before task/Valence/worktree creation. Text-only calls keep their synchronous preparation.
      const images = input.images?.length ? await validateTaskImages(input.images) : undefined
      const project = store.getProjects(workspaceId).find((project) => project.id === input.projectId)
      if (!project) throw new Error('Project not found')

      if (input.fileReferences?.length) {
        await validateTaskFileReferences(project.path, input.fileReferences)
        if (!store.getProjects(workspaceId).some((item) => item.id === project.id && item.path === project.path)) throw new Error('Project changed')
      }
      const taskPrompt = promptWithFileReferences(input.prompt, project.path, input.fileReferences ?? [])
      const agent = getAgent(input.agentId)
      if (!agent) throw new Error(`Unknown agent: ${input.agentId}`)

      if (images?.length && !['acp', 'codex-app-server'].includes(agent.executionProtocol ?? '')) {
        throw new Error(`${agent.label} does not support image attachments. Choose Codex or OpenCode with an image-capable model.`)
      }
      const model = input.model || agent.defaultModel
      const style = input.style ?? 'work'
      const checkoutMode = input.checkoutMode ?? (style === 'quick' ? 'local' : 'worktree')
      if (style === 'work' && checkoutMode !== 'worktree') throw new Error('Work tasks require an isolated worktree')
      if (style !== 'work' && input.parentTaskId) throw new Error('Only Work tasks can be stacked')
      if (style !== 'work' && input.reviewPolicy === 'review_at_task_end') throw new Error('Only Work tasks can use end-of-task review')
      if (checkoutMode === 'local' && input.startBase !== undefined) throw new Error('Local checkout tasks cannot choose a worktree start base')
      if (input.parentTaskId && input.startBase !== undefined) throw new Error('Stacked tasks start from their parent task')
      const task: Task = {
        id: randomUUID(),
        style,
        reviewPolicy: style === 'work' ? input.reviewPolicy ?? 'review_each_issue' : 'review_each_issue',
        checkoutMode,
        ...(input.startBase === undefined ? {} : { startBase: input.startBase }),
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
      if (input.parentTaskId) requireStackParent(store, task, input.parentTaskId)
      task.parentTaskId = input.parentTaskId
      requireProjectCheckoutAvailable(store, task)
      store.addTask(task)
      try {
        if (images?.length) store.taskImages.save(task.id, images)
        initializeTask(task.id, project.path, { reasoningEffort: input.reasoningEffort, ...(images?.length ? { hasImages: true } : {}) })
      } catch (error) {
        store.taskImages.remove(task.id)
        const message = error instanceof Error ? error.message : String(error)
        const failed = store.updateTask(task.id, {
          status: 'pending', endedAt: Date.now(), error: message,
          deliveryStatus: 'failed', deliveryError: message
        })!
        recordSystemEvent(task.id, `Could not start task: ${message}`, 'delivery', 'error')
        stopTask(task.id, message)
        send('task:updated', failed)
        return failed
      }
      if (task.parentTaskId) recordSystemEvent(task.id, 'Queued behind the parent task. Work starts after its Git delivery finishes.')
      // Creation is acknowledged independently of memory lookup and checkout.
      // Every client must see preparing tasks, including tasks queued on a parent.
      send('task:updated', task)
      void startTask(task.id).catch((error) => console.warn('Could not start created task:', error))
      return task
    }
  )

  ipc.handle('tasks:cancel', (taskId: string) => {
    const detachChildren = (): void => {
      void stacks.restackChildren(taskId, true).catch((error) => recordSystemEvent(taskId, String(error), 'delivery', 'error'))
    }
    const operation = taskOperationKind(store, taskId)
    const cancelledOperation = cancelTaskOperation(store, taskId)
    if (operation === 'merge-repair') {
      return agentProcesses.isRunning(taskId) ? agentProcesses.cancel(taskId) : cancelledOperation
    }
    if (agentProcesses.isRunning(taskId)) {
      store.taskImages.remove(taskId)
      recordSystemEvent(taskId, 'Stop requested by user.')
      detachChildren()
      return agentProcesses.cancel(taskId)
    }
    // Cancellation must also cover the gap between sequential agent processes.
    const state = store.getTaskExecution(taskId)
    if (!state || state.phase === 'complete' || store.getTask(taskId)?.status !== 'running') return cancelledOperation
    store.taskImages.remove(taskId)
    recordSystemEvent(taskId, 'Stop requested by user.')
    detachChildren()
    void finishTaskTurn({ taskId, code: null, cancelled: true })
    return true
  })
}
