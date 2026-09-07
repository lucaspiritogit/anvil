import { existsSync } from 'node:fs'
import { GIT_SYSTEM_PROMPT, getAgent } from '../agents/registry'
import { implementationPrompt } from '../agents/task-prompts'
import type { ExitInfo } from '../agents/process-manager'
import type { TaskContext } from './context'
import { TaskIssues } from './task-issues'
import type { TaskExecutionState } from '../../shared/types'

export interface TaskExecution {
  initializeTask(taskId: string, projectPath: string, settings?: Pick<TaskExecutionState, 'thinkingLevel' | 'modelEffort'>): void
  resumeTask(taskId: string): TaskExecutionState
  stopTask(taskId: string, error: string): void
  finishTaskTurn(info: ExitInfo): Promise<void>
  requireFinishedTask(taskId: string): void
}

/** Anvil runs one turn per claimed issue and delivers one final task diff. */
export function registerTaskExecution(
  { store, agentProcesses, gitDelivery, send }: TaskContext,
  finishTask: (info: ExitInfo) => Promise<void>
): TaskExecution {
  const issues = new TaskIssues(store)
  const notify = (taskId: string): void => {
    const task = store.getTask(taskId)
    if (task) send('task:updated', task)
  }
  const initializeTask: TaskExecution['initializeTask'] = (taskId, projectPath, settings = {}) => {
    const state = issues.initialize(taskId, projectPath)
    store.saveTaskExecution({ ...state, ...settings })
    notify(taskId)
  }
  const stopTask = (taskId: string, error: string): void => {
    issues.stop(taskId, error)
    notify(taskId)
  }

  // Process/worktree reservations are Anvil policy, not Valence scheduling rules.
  const starting = new Set<string>()
  const startNextTurn = async (taskId: string): Promise<void> => {
    if (starting.has(taskId) || agentProcesses.isRunning(taskId)) return
    starting.add(taskId)
    try {
      const task = store.getTask(taskId)
      const state = store.getTaskExecution(taskId)
      if (!task || task.status !== 'running' || state?.phase !== 'working') return
      const project = store.getProjects().find((entry) => entry.id === task.projectId)
      if (!project) throw new Error('Project not found')
      const agent = getAgent(task.agentId)
      if (!agent) throw new Error('Agent not found')
      let cwd = task.cwd
      let worktreePath = task.worktreePath
      if (task.branchName && (!worktreePath || !existsSync(worktreePath))) {
        const reopened = await gitDelivery.reopen(project.path, taskId, task.branchName)
        cwd = reopened.cwd
        worktreePath = reopened.worktreePath
      }
      if (store.getTask(taskId)?.status !== 'running') return
      const issue = issues.claim(taskId)
      if (!issue) throw new Error('No task issue is ready in Valence. Inspect dependencies and work claimed by other clients.')
      const running = store.updateTask(taskId, {
        cwd, worktreePath, endedAt: undefined, error: undefined, exitCode: null,
        deliveryStatus: worktreePath ? 'working' : 'unavailable', deliveryError: undefined
      })!
      send('task:updated', running)
      agentProcesses.start({
        taskId, issueId: issue.id, agent, cwd, projectPath: project.path, model: task.model,
        thinkingLevel: state.thinkingLevel, modelEffort: state.modelEffort,
        prompt: `${worktreePath ? GIT_SYSTEM_PROMPT : ''}\n\n${implementationPrompt(task.prompt, issue, project.path)}`
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      stopTask(taskId, message)
      if (store.getTask(taskId)?.status === 'running') await finishTask({ taskId, code: 1, cancelled: false, error: message })
    } finally {
      starting.delete(taskId)
    }
  }

  const finishing = new Set<string>()
  const finishTaskTurn = async (info: ExitInfo): Promise<void> => {
    const state = store.getTaskExecution(info.taskId)
    if (!state || store.getTask(info.taskId)?.status !== 'running' || finishing.has(info.taskId)) return
    if (info.result?.issueId && info.result.issueId !== state.currentIssueId) return
    finishing.add(info.taskId)
    try {
      if (state.phase === 'complete') {
        await finishTask(info)
        return
      }
      if (state.phase === 'blocked') return
      if (info.cancelled || info.code !== 0) throw new Error(info.error ?? (info.cancelled ? 'Task cancelled.' : 'Agent failed.'))
      if (state.phase === 'planning') {
        issues.finishPlanning(info.taskId)
      } else if (state.phase === 'recovering') {
        issues.finishRecovery(info.taskId)
      } else {
        issues.finishIssue(info.taskId)
      }
      notify(info.taskId)
      if (store.getTaskExecution(info.taskId)?.phase === 'complete') {
        await finishTask(info)
      } else {
        setImmediate(() => { void startNextTurn(info.taskId) })
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      stopTask(info.taskId, message)
      if (store.getTask(info.taskId)?.status === 'running') await finishTask({ ...info, code: 1, error: message })
    } finally {
      finishing.delete(info.taskId)
    }
  }

  agentProcesses.on('exit', (info: ExitInfo) => { void finishTaskTurn(info) })

  const requireFinishedTask = (taskId: string): void => {
    const task = store.getTask(taskId)
    if (task?.status === 'running' || agentProcesses.isRunning(taskId) ||
      task?.deliveryStatus === 'finalizing' || task?.deliveryStatus === 'did_not_commit') {
      throw new Error('This task has not finished executing')
    }
    const state = store.getTaskExecution(taskId)
    if (state?.phase !== 'complete' || issues.list(taskId).some((issue) => issue.status !== 'complete')) {
      throw new Error('This task has not finished executing')
    }
  }

  const resumeTask = (taskId: string): TaskExecutionState => {
    if (starting.has(taskId) || finishing.has(taskId) || agentProcesses.isRunning(taskId)) {
      throw new Error('This task has not finished stopping. Wait and try again.')
    }
    return issues.resume(taskId)
  }

  return { initializeTask, resumeTask, stopTask, finishTaskTurn, requireFinishedTask }
}
