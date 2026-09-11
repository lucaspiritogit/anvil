import { TaskStacks, requireStackMergeable } from '../tasks/task-stacks'
import { TaskIssues } from '../tasks/task-issues'
import type { HandlerRegistry } from '../handler-registry'
import { randomUUID } from 'node:crypto'
import { getAgent } from '../agents/registry'
import { withTaskOperation } from '../tasks/operations'
import { resumeTaskTurn } from '../tasks/resume'
import { issueReworkPrompt, reviewPrompt } from '../agents/task-prompts'
import type { RecordSystemEvent, TaskContext } from '../tasks/context'
import type { TaskExecution } from '../tasks/task-execution'
import type { Task, TaskMergePreview } from '../../shared/types'
import { isTaskSettled } from '../../shared/task-settlement'

interface ReviewHandlerDependencies extends TaskContext {
  recordSystemEvent: RecordSystemEvent
  requireFinishedTask: TaskExecution['requireFinishedTask']
  approveIssue: TaskExecution['approveIssue']
  rejectIssue: TaskExecution['rejectIssue']
}

export function registerReviewHandlers(ipc: HandlerRegistry, {
  store, agentProcesses, gitDelivery, send, recordSystemEvent, requireFinishedTask, approveIssue, rejectIssue
}: ReviewHandlerDependencies): void {
  const requireReviewableTask = (taskId: string) => {
    requireFinishedTask(taskId)
    const task = store.getTask(taskId)
    if (!task) throw new Error('Task not found')
    requireStackMergeable(store, task)
    if (task.deliveryStatus !== 'reviewable') throw new Error('This task is not awaiting review')
    if (!task.branchName) throw new Error('This task has no branch to merge')
    const project = store.getProjects(task?.workspaceId).find((item) => item.id === task.projectId)
    if (!project) throw new Error('Project not found')
    return { project, branchName: task.branchName }
  }

  ipc.handle('tasks:merge-preview', async (taskId: string): Promise<TaskMergePreview> => {
    const { project, branchName } = requireReviewableTask(taskId)
    return gitDelivery.getMergePreview(project.path, branchName)
  })

  ipc.handle('tasks:approve', async (input): Promise<Task> => {
    const { taskId, preview } = input
    return withTaskOperation(store, taskId, 'merge', async (check) => {
      const { project, branchName } = requireReviewableTask(taskId)
      const guard = () => {
        check()
        requireReviewableTask(taskId)
      }
      await gitDelivery.merge(project.path, branchName, preview, guard)
      guard()
      const approved = store.updateTask(taskId, { deliveryStatus: 'approved', reviewedAt: Date.now() })
      if (!approved) throw new Error('Task was deleted')
      recordSystemEvent(taskId, `Merged ${branchName} into ${preview.targetBranch} with git merge, bringing in ${preview.commitCount} commit${preview.commitCount === 1 ? '' : 's'}.`)
      send('task:updated', approved)
      await new TaskStacks({ store, agentProcesses, gitDelivery, send }).restackChildren(taskId)
      return approved
    })
  })

  const requireCurrentReview = (input: { taskId: string; issueId: string; headCommit: string | null }): void => {
    const state = store.getTaskExecution(input.taskId)
    if (state?.currentIssueId !== input.issueId ||
      new TaskIssues(store).issueDiffSource(input.taskId, input.issueId).headCommit !== input.headCommit) {
      throw new Error('The pending review changed. Refresh and review the latest changes.')
    }
  }

  ipc.handle('tasks:approve-issue', (input): Promise<Task> =>
    withTaskOperation(store, input.taskId, 'review', async () => {
      requireCurrentReview(input)
      const taskId = input.taskId
      const pending = store.getComments(taskId).filter((comment) => comment.sentAt === null)
      await approveIssue(taskId)
      for (const comment of pending) store.removeComment(comment.id)
      const approved = store.getTask(taskId)
      if (!approved) throw new Error('Task was deleted')
      return approved
    })
  )

  ipc.handle('tasks:reject-issue', (input): Promise<Task> =>
    withTaskOperation(store, input.taskId, 'review', async (check) => {
      requireCurrentReview(input)
      const body = input.comment?.trim()
      const state = rejectIssue(input.taskId)
      const rejected = store.getTask(input.taskId)
      if (!rejected) throw new Error('Task was deleted')
      if (body) store.addComment({
        id: randomUUID(),
        taskId: input.taskId,
        file: '',
        side: 'additions',
        lineNumber: 0,
        body,
        createdAt: Date.now(),
        sentAt: null
      })
      const pending = store.getComments(input.taskId).filter((comment) => comment.sentAt === null)
      const running = await resumeTaskTurn({ store, agentProcesses, gitDelivery, send }, {
        check: (expected = rejected) => check(expected),
        validate: (task) => {
          if (isTaskSettled(task)) throw new Error('This task is settled and cannot be reworked')
          if (!state.currentIssueId) throw new Error('This task has no issue to rework')
        },
        prompt: () => issueReworkPrompt(state.projectPath, state.currentIssueId!, pending)
      })
      if (pending.length) store.markCommentsSent(input.taskId, Date.now(), pending.map((comment) => comment.id))
      recordSystemEvent(input.taskId, `Sent ${pending.length} pending review ${pending.length === 1 ? 'comment' : 'comments'} back to ${getAgent(running.agentId)!.label}.`)
      return store.getTask(input.taskId) ?? running
    })
  )

  ipc.handle('comments:list', (taskId: string) => store.getComments(taskId))

  ipc.handle(
    'comments:add',
    (input) => {
      if (!store.getTask(input.taskId)) throw new Error('Task not found')
      const body = input.body.trim()
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

  ipc.handle('comments:remove', (input) => {
    if (!store.getTask(input.taskId)) throw new Error('Task not found')
    if (!store.getComments(input.taskId).some((comment) => comment.id === input.id)) {
      throw new Error('Comment does not belong to this task')
    }
    store.removeComment(input.id)
    return store.getComments(input.taskId)
  })

  ipc.handle('comments:send', async (taskId: string) => {
    return withTaskOperation(store, taskId, 'review', async (check) => {
      requireFinishedTask(taskId)
      const pending = store.getComments(taskId).filter((comment) => comment.sentAt === null)
      if (!pending.length) throw new Error('There are no comments to send')
      const running = await resumeTaskTurn({ store, agentProcesses, gitDelivery, send }, {
        check,
        validate: (task) => {
          requireFinishedTask(taskId)
          if (!task.branchName) throw new Error('This task has no branch to review')
        },
        prompt: () => reviewPrompt(pending)
      })
      const sent = store.markCommentsSent(taskId, Date.now(), pending.map((comment) => comment.id))
      recordSystemEvent(taskId, `Sent ${sent.length} review ${sent.length === 1 ? 'comment' : 'comments'} back to ${getAgent(running.agentId)!.label}.`)
      return { task: running, comments: store.getComments(taskId) }
    })
  })
}
