import { existsSync } from 'node:fs'
import { GIT_SYSTEM_PROMPT, getAgent } from '../agents/registry'
import type { ExitInfo } from '../agents/process-manager'
import { issueTrackerPrompt, completionEvidence, nextIssue, parsePlan } from '../issue-tracker'
import type { IssueTracker } from '../../shared/types'
import type { TaskContext } from './context'

export interface IssueExecution {
  publishIssueTracker(tracker: IssueTracker): IssueTracker
  finishIssueTracker(info: ExitInfo): Promise<void>
  requireFinishedTracker(taskId: string): void
}

/** Owns sequential issue scheduling and the transition to final task delivery. */
export function registerIssueExecution(
  { store, agentProcesses, gitDelivery, send }: TaskContext,
  finishTask: (info: ExitInfo) => Promise<void>
): IssueExecution {
  const publishIssueTracker = (tracker: IssueTracker): IssueTracker => {
    const task = store.getTask(tracker.taskId)
    if (task) {
      store.saveIssueTracker(tracker)
      send('task:updated', task)
    }
    return tracker
  }

  // Reserve execution before awaiting Git so only one issue can run at a time.
  const trackerBusy = new Set<string>()
  const startIssueTracker = async (taskId: string): Promise<void> => {
    if (trackerBusy.has(taskId) || agentProcesses.isRunning(taskId)) throw new Error('This tracker is already running')
    trackerBusy.add(taskId)
    try {
      const tracker = store.getIssueTracker(taskId)
      const task = store.getTask(taskId)
      if (!task || !tracker || task.status !== 'running' || tracker.phase === 'blocked') return
      const project = store.getProjects().find((entry) => entry.id === task.projectId)!
      const agent = getAgent(task.agentId)
      if (!agent) throw new Error('Agent not found')
      let cwd = task.cwd
      let worktreePath = task.worktreePath
      if (!task.branchName && (await gitDelivery.status(project.path)).isRepository) {
        const prepared = await gitDelivery.prepare(project.path, taskId, task.title)
        store.updateTask(taskId, prepared)
        Object.assign(task, prepared)
        cwd = prepared.cwd
        worktreePath = prepared.worktreePath
      }
      if (task.branchName && (!worktreePath || !existsSync(worktreePath))) {
        const reopened = await gitDelivery.reopen(project.path, taskId, task.branchName)
        cwd = reopened.cwd
        worktreePath = reopened.worktreePath
      }
      if (store.getTask(taskId)?.status !== 'running') return
      const item = nextIssue(tracker)
      if (tracker.items.length && !item) throw new Error('No issue is ready to execute')
      if (item) {
        item.status = 'working'
        item.evidence = undefined
      }
      publishIssueTracker({ ...tracker, phase: item ? 'working' : 'planning', error: null, eventOffset: store.readEvents(taskId).length })
      const running = store.updateTask(taskId, {
        status: 'running', cwd, worktreePath, endedAt: undefined, error: undefined,
        exitCode: null, deliveryStatus: worktreePath ? 'working' : 'unavailable', deliveryError: undefined
      })!
      send('task:updated', running)
      agentProcesses.start({
        taskId, issueId: item?.id, agent, cwd, model: task.model,
        prompt: `${item && worktreePath ? GIT_SYSTEM_PROMPT : ''}\n\n${issueTrackerPrompt(tracker, task.prompt)}`
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const tracker = store.getIssueTracker(taskId)
      if (tracker) publishIssueTracker({ ...tracker, phase: 'blocked', error: message })
      const failed = store.updateTask(taskId, { status: 'failed', error: message, endedAt: Date.now() })
      if (failed) send('task:updated', failed)
    } finally {
      trackerBusy.delete(taskId)
    }
  }

  const finishIssueTracker = async (info: ExitInfo): Promise<void> => {
    const tracker = store.getIssueTracker(info.taskId)
    // A deleted task may still receive the cancelled process's final exit event.
    if (!tracker) return
    if (tracker.phase === 'complete') return finishTask(info)
    try {
      if (info.cancelled || info.code !== 0) throw new Error(info.error ?? (info.cancelled ? 'Task cancelled.' : 'Agent failed.'))
      const output = info.result?.output ?? store.readEvents(info.taskId).slice(tracker.eventOffset)
        .filter((event) => event.category === 'message' && event.stream === 'stdout')
        .map((event) => event.text).join('\n')
      if (!tracker.items.length) {
        tracker.items = parsePlan(output, tracker.limit)
        publishIssueTracker(tracker)
        // Let the start reservation from synchronous spawn failures clear first.
        setImmediate(() => { void startIssueTracker(info.taskId) })
        return
      }
      const item = tracker.items.find((entry) => entry.status === 'working')
      if (!item) throw new Error('No issue is currently running')
      item.evidence = completionEvidence(output, item)
      item.status = 'complete'
      item.completedAt = Date.now()
      const complete = tracker.items.every((entry) => entry.status === 'complete')
      publishIssueTracker({ ...tracker, phase: complete ? 'complete' : 'working', error: null })
      if (complete) {
        await finishTask(info)
      } else {
        setImmediate(() => { void startIssueTracker(info.taskId) })
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (store.getTask(info.taskId)?.status === 'running') {
        await finishTask({ ...info, code: 1, error: message })
      }
      const item = tracker.items.find((entry) => entry.status === 'working')
      if (item) item.status = 'blocked'
      publishIssueTracker({ ...tracker, phase: 'blocked', error: message })
    }
  }

  agentProcesses.on('exit', (info: ExitInfo) => { void finishIssueTracker(info) })

  const requireFinishedTracker = (taskId: string): void => {
    const tracker = store.getIssueTracker(taskId)
    if (!tracker) throw new Error('Task issue tracker not found')
    if (tracker.phase !== 'complete') throw new Error('This task has not finished executing')
  }

  return { publishIssueTracker, finishIssueTracker, requireFinishedTracker }
}
