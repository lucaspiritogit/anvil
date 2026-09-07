import { ipcMain } from 'electron'
import { randomUUID } from 'node:crypto'
import { GIT_SYSTEM_PROMPT, getAgent } from '../agents/registry'
import { reviewPrompt } from '../agents/task-prompts'
import type { RecordSystemEvent, TaskContext } from '../tasks/context'
import type { TaskExecution } from '../tasks/task-execution'
import type { Task, TaskComment, TaskMergePreview } from '../../shared/types'

interface ReviewHandlerDependencies extends TaskContext {
  recordSystemEvent: RecordSystemEvent
  requireFinishedTask: TaskExecution['requireFinishedTask']
}

export function registerReviewHandlers({
  store, agentProcesses, gitDelivery, send, recordSystemEvent, requireFinishedTask
}: ReviewHandlerDependencies): void {
  const approving = new Set<string>()
  const requireReviewableTask = (taskId: string) => {
    requireFinishedTask(taskId)
    const task = store.getTask(taskId)
    if (!task) throw new Error('Task not found')
    if (task.deliveryStatus !== 'reviewable') throw new Error('This task is not awaiting review')
    if (!task.branchName) throw new Error('This task has no branch to merge')
    const project = store.getProjects().find((item) => item.id === task.projectId)
    if (!project) throw new Error('Project not found')
    return { project, branchName: task.branchName }
  }

  ipcMain.handle('tasks:merge-preview', async (_event, taskId: string): Promise<TaskMergePreview> => {
    const { project, branchName } = requireReviewableTask(taskId)
    return gitDelivery.getMergePreview(project.path, branchName)
  })

  ipcMain.handle('tasks:approve', async (_event, input: { taskId: string; preview: TaskMergePreview }): Promise<Task> => {
    const { taskId, preview } = input
    if (approving.has(taskId)) throw new Error('This task is already being approved')
    const { project, branchName } = requireReviewableTask(taskId)
    approving.add(taskId)
    try {
      await gitDelivery.merge(project.path, branchName, preview)
      const approved = store.updateTask(taskId, { deliveryStatus: 'approved', reviewedAt: Date.now() })
      if (!approved) throw new Error('Task was deleted')
      recordSystemEvent(taskId, `Merged ${branchName} into ${preview.targetBranch} with git merge, bringing in ${preview.commitCount} commit${preview.commitCount === 1 ? '' : 's'}.`)
      send('task:updated', approved)
      return approved
    } finally {
      approving.delete(taskId)
    }
  })

  ipcMain.handle('comments:list', (_event, taskId: string) => store.getComments(taskId))

  ipcMain.handle(
    'comments:add',
    (_event, input: { taskId: string; file: string; side: TaskComment['side']; lineNumber: number; body: string }) => {
      const body = input.body.trim()
      if (!body) throw new Error('A comment needs some text')
      store.addComment({
        id: randomUUID(),
        taskId: input.taskId,
        file: input.file,
        side: input.side,
        lineNumber: input.lineNumber,
        body,
        createdAt: Date.now(),
        sentAt: null
      })
      return store.getComments(input.taskId)
    }
  )

  ipcMain.handle('comments:remove', (_event, input: { taskId: string; id: string }) => {
    store.removeComment(input.id)
    return store.getComments(input.taskId)
  })

  // Resume the original agent session on the task branch with pending review notes.
  ipcMain.handle('comments:send', async (_event, taskId: string) => {
    requireFinishedTask(taskId)
    if (approving.has(taskId)) throw new Error('This task is being approved')
    const task = store.getTask(taskId)
    if (!task) throw new Error('Task not found')
    if (agentProcesses.isRunning(taskId)) throw new Error('This task is already running')
    if (!task.branchName) throw new Error('This task has no branch to review')

    const project = store.getProjects().find((item) => item.id === task.projectId)
    if (!project) throw new Error('Project not found')

    const agent = getAgent(task.agentId)
    if (!agent) throw new Error(`Unknown agent: ${task.agentId}`)

    const pending = store.getComments(taskId).filter((comment) => comment.sentAt === null)
    if (!pending.length) throw new Error('There are no comments to send')

    const reopened = await gitDelivery.reopen(project.path, taskId, task.branchName)
    if (!store.getTask(taskId)) throw new Error('Task was deleted')
    const sent = store.markCommentsSent(taskId, Date.now())

    const running = store.updateTask(taskId, {
      status: 'running',
      cwd: reopened.cwd,
      endedAt: undefined,
      exitCode: null,
      error: undefined,
      deliveryStatus: 'working',
      worktreePath: reopened.worktreePath,
      deliveryError: undefined
    })!
    send('task:updated', running)

    recordSystemEvent(
      taskId,
      `Sent ${sent.length} review ${sent.length === 1 ? 'comment' : 'comments'} back to ${agent.label}.`
    )

    const resumeSessionId = task.sessionId

    setImmediate(() => {
      if (store.getTask(taskId)?.status !== 'running') return
      agentProcesses.start({
        taskId,
        agent,
        prompt: `${GIT_SYSTEM_PROMPT}\n\n${reviewPrompt(sent)}`,
        model: task.model,
        reasoningEffort: store.getTaskExecution(taskId)?.reasoningEffort,
        projectPath: project.path,
        cwd: reopened.cwd,
        ...(resumeSessionId ? { resumeSessionId } : {})
      })
    })
    return { task: running, comments: store.getComments(taskId) }
  })
}
