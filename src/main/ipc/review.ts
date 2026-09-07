import { ipcMain } from 'electron'
import { randomUUID } from 'node:crypto'
import { GIT_SYSTEM_PROMPT, getAgent } from '../agents/registry'
import { reviewPrompt } from '../agents/task-prompts'
import type { RecordSystemEvent, TaskContext } from '../tasks/context'
import type { TaskExecution } from '../tasks/task-execution'
import type { TaskComment } from '../../shared/types'

interface ReviewHandlerDependencies extends TaskContext {
  recordSystemEvent: RecordSystemEvent
  requireFinishedTask: TaskExecution['requireFinishedTask']
}

export function registerReviewHandlers({
  store, agentProcesses, gitDelivery, send, recordSystemEvent, requireFinishedTask
}: ReviewHandlerDependencies): void {
  // Approval takes a reviewed task out of the review queue.
  ipcMain.handle('tasks:approve', (_event, taskId: string) => {
    requireFinishedTask(taskId)
    const task = store.getTask(taskId)
    if (!task) throw new Error('Task not found')
    if (task.deliveryStatus !== 'reviewable') throw new Error('This task is not awaiting review')

    const approved = store.updateTask(taskId, { deliveryStatus: 'approved', reviewedAt: Date.now() })!
    send('task:updated', approved)
    return approved
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
        thinkingLevel: store.getTaskExecution(taskId)?.thinkingLevel,
        modelEffort: store.getTaskExecution(taskId)?.modelEffort,
        projectPath: project.path,
        cwd: reopened.cwd,
        ...(resumeSessionId ? { resumeSessionId } : {})
      })
    })
    return { task: running, comments: store.getComments(taskId) }
  })
}
