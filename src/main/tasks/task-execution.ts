import { resolveTaskWorkspace } from '../agents/workspace-execution'
import { GIT_SYSTEM_PROMPT, getAgent } from '../agents/registry'
import { implementationPrompt, taskRecoveryPrompt } from '../agents/task-prompts'
import type { ExitInfo } from '../agents/process-manager'
import type { TaskContext } from './context'
import type { RecordSystemEvent } from './context'
import { TaskIssues, type VerifiedNoChanges } from './task-issues'
import type { TaskCompletion } from './completion'
import type { TaskExecutionState } from '../../shared/types'

const MAX_RECOVERY_ATTEMPTS = 3
const RECOVERY_WINDOW_MS = 120_000

interface TaskRetry {
  attempt: number
  deadline: number
  timer?: ReturnType<typeof setTimeout>
}

export interface TaskExecution {
  initializeTask(taskId: string, projectPath: string, settings?: Pick<TaskExecutionState, 'reasoningEffort' | 'hasImages'>): TaskExecutionState
  resumeTask(taskId: string): TaskExecutionState
  stopTask(taskId: string, error: string): void
  finishTaskTurn(info: ExitInfo): Promise<void>
  requireFinishedTask(taskId: string): void
  issueReviewReady(taskId: string): boolean
  approveIssue(taskId: string): Promise<TaskExecutionState>
  rejectIssue(taskId: string): TaskExecutionState
}

/** Anvil runs one turn per claimed issue and pauses for review when finalized changes remain. */
export function registerTaskExecution(
  { store, agentProcesses, gitDelivery, send, recordSystemEvent }: TaskContext & { recordSystemEvent: RecordSystemEvent },
  finishTask: TaskCompletion
): TaskExecution {
  const issues = new TaskIssues(store)
  // Retries belong to this running scheduler. App restarts retain the existing
  // interrupted-task recovery policy instead of silently relaunching work.
  const retries = new Map<string, TaskRetry>()
  let closing = false
  const clearRetry = (taskId: string): void => {
    clearTimeout(retries.get(taskId)?.timer)
    retries.delete(taskId)
  }
  agentProcesses.on('closing', () => {
    closing = true
    for (const taskId of retries.keys()) clearRetry(taskId)
  })
  const notify = (taskId: string): void => {
    const task = store.getTask(taskId)
    if (task) send('task:updated', task)
  }
  const initializeTask: TaskExecution['initializeTask'] = (taskId, projectPath, settings = {}) => {
    const saved = store.transaction(() => {
      const state = issues.initialize(taskId, projectPath)
      return store.saveTaskExecution({ ...state, ...settings })
    }, store.getTask(taskId)?.workspaceId)
    notify(taskId)
    return saved
  }
  const stopTask = (taskId: string, error: string): void => {
    clearRetry(taskId)
    issues.stop(taskId, error)
    notify(taskId)
  }

  // Each task runs one agent process at a time; other tasks have their own worktrees.
  const starting = new Set<string>()

  const startNextTurn = async (taskId: string): Promise<void> => {
    if (closing || starting.has(taskId) || agentProcesses.isRunning(taskId)) return
    starting.add(taskId)
    try {
      const task = store.getTask(taskId)
      const state = store.getTaskExecution(taskId)
      if (!task || task.status !== 'running' || state?.phase !== 'working') return
      const project = store.getProjects(task?.workspaceId).find((entry) => entry.id === task.projectId)
      if (!project) throw new Error('Project not found')
      const agent = getAgent(task.agentId)
      if (!agent) throw new Error('Agent not found')
      const workspace = resolveTaskWorkspace(store, task.id)
      let cwd = task.cwd
      let baseCommit: string | undefined
      if (task.branchName) {
        const checkout = await gitDelivery.checkoutBranch(project.path, taskId, task.branchName, task.baseBranch, () => {
          if (store.getTask(taskId)?.status !== 'running') throw new Error('Task stopped before the next issue')
        })
        cwd = checkout.cwd
        baseCommit = checkout.baseCommit
      }
      if (store.getTask(taskId)?.status !== 'running') {
        if (!store.getTask(taskId)) void gitDelivery.releaseWorktree(taskId)
        return
      }
      const images = state.hasImages ? store.taskImages.read(taskId) : undefined
      if (state.hasImages && !images) throw new Error('The original task images were cleared. Start a new task and attach the images again.')
      const issue = issues.claim(taskId, baseCommit)
      if (!issue) throw new Error('No task issue is ready in Valence. Inspect dependencies and work claimed by other clients.')
      const running = store.updateTask(taskId, {
        cwd, endedAt: undefined, error: undefined, exitCode: null,
        deliveryStatus: task.branchName ? 'working' : 'unavailable', deliveryError: undefined
      })!
      send('task:updated', running)
      agentProcesses.start({
        workspace,
        taskId, issueId: issue.id, agent, cwd, projectPath: project.path, model: task.model,
        reasoningEffort: state.reasoningEffort,
        images,
        prompt: `${task.branchName ? GIT_SYSTEM_PROMPT : ''}\n\n${implementationPrompt(task.prompt, issue, project.path)}`
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      stopTask(taskId, message)
      if (store.getTask(taskId)?.status === 'running') await finishTask({ taskId, code: 1, cancelled: false, error: message })
    } finally {
      starting.delete(taskId)
    }
  }

  const scheduleRetry = (info: ExitInfo): boolean => {
    const retry = info.result?.retry
    const task = store.getTask(info.taskId)
    const state = store.getTaskExecution(info.taskId)
    const sessionId = info.result?.sessionId
    if (closing || !retry || !task || !state || !sessionId || task.sessionId !== sessionId ||
      task.status !== 'running' || agentProcesses.isRunning(task.id) ||
      !['planning', 'working', 'recovering'].includes(state.phase)) return false
    const previous = retries.get(task.id)
    const attempt = (previous?.attempt ?? 0) + 1
    const deadline = previous?.deadline ?? Date.now() + RECOVERY_WINDOW_MS
    const backoff = Math.min(2_000 * 2 ** (attempt - 1), 30_000) + Math.floor(Math.random() * 1_000)
    const afterMs = retry.afterMs !== undefined && Number.isFinite(retry.afterMs) ? Math.max(0, retry.afterMs) : 0
    const delay = Math.max(afterMs, backoff)
    if (attempt > MAX_RECOVERY_ATTEMPTS || Date.now() + delay > deadline) {
      recordSystemEvent(task.id, 'Automatic recovery exhausted. Task will pause for intervention.')
      return false
    }
    const pending: TaskRetry = { attempt, deadline }
    retries.set(task.id, pending)
    const stillCurrent = (): boolean => {
      if (closing || retries.get(task.id) !== pending) return false
      const current = store.getTask(task.id)
      const execution = store.getTaskExecution(task.id)
      return current?.status === 'running' && current.sessionId === sessionId &&
        current.workspaceId === task.workspaceId && current.projectId === task.projectId &&
        current.agentId === task.agentId && current.cwd === task.cwd && current.branchName === task.branchName &&
        execution?.phase === state.phase && execution.currentIssueId === state.currentIssueId
    }
    pending.timer = setTimeout(() => {
      pending.timer = undefined
      void (async () => {
        if (!stillCurrent()) {
          if (retries.get(task.id) === pending) clearRetry(task.id)
          return
        }
        try {
          if (agentProcesses.isRunning(task.id)) return
          const issue = state.currentIssueId ? issues.list(task.id).find((item) => item.id === state.currentIssueId) : undefined
          if (issue?.status === 'review' || issue?.status === 'complete') {
            await finishTaskTurn({ ...info, code: 0, error: undefined })
            return
          }
          if (issue && issue.status !== 'working') throw new Error(`Issue ${issue.id} is ${issue.status}; recovery stopped.`)
          const project = store.getProjects(task.workspaceId).find((item) => item.id === task.projectId)
          const agent = getAgent(task.agentId)
          if (!project || project.path !== state.projectPath || !agent) throw new Error('Task project or agent is unavailable')
          recordSystemEvent(task.id, `Resuming the saved agent session, attempt ${attempt}/${MAX_RECOVERY_ATTEMPTS}.`)
          agentProcesses.start({
            taskId: task.id, issueId: state.currentIssueId ?? undefined,
            workspace: resolveTaskWorkspace(store, task.id), agent, cwd: task.cwd,
            projectPath: project.path, model: task.model, reasoningEffort: state.reasoningEffort,
            resumeSessionId: sessionId,
            beforeDispatch: () => {
              if (!stillCurrent()) throw new Error('Task recovery was cancelled or superseded')
            },
            prompt: taskRecoveryPrompt(task, state)
          })
        } catch (error) {
          if (!stillCurrent()) return
          await finishTaskTurn({ taskId: task.id, code: 1, cancelled: false,
            error: error instanceof Error ? error.message : String(error) })
        }
      })()
    }, delay)
    pending.timer.unref()
    recordSystemEvent(task.id, `Temporary agent failure. Retrying in ${Math.ceil(delay / 1000)}s, attempt ${attempt}/${MAX_RECOVERY_ATTEMPTS}: ${info.error ?? 'Connection failed.'}`)
    return true
  }

  const finishing = new Set<string>()
  const cancelledFinishes = new Set<string>()
  const finishTaskTurn = async (info: ExitInfo): Promise<void> => {
    const state = store.getTaskExecution(info.taskId)
    if (!state || store.getTask(info.taskId)?.status !== 'running') return
    if (finishing.has(info.taskId)) {
      if (info.cancelled) cancelledFinishes.add(info.taskId)
      return
    }
    if (state.phase === 'reviewing' && !info.cancelled) return
    if (state.phase === 'working' && !state.currentIssueId && !info.cancelled) return
    if (agentProcesses.isRunning(info.taskId)) return
    if (info.result?.issueId && info.result.issueId !== state.currentIssueId) return
    // Duplicate exit notifications must not consume the retry budget or timers.
    if (retries.get(info.taskId)?.timer && !info.cancelled) return
    finishing.add(info.taskId)
    let finalizing = false
    const check = (): void => {
      if (cancelledFinishes.has(info.taskId)) {
        info = { ...info, cancelled: true }
        throw new Error('Task cancelled.')
      }
      const current = store.getTaskExecution(info.taskId)
      if (closing || store.getTask(info.taskId)?.status !== 'running' ||
        current?.phase !== state.phase || current.currentIssueId !== state.currentIssueId) {
        throw new Error('Task finalization was interrupted or superseded.')
      }
    }
    try {
      if (state.phase === 'complete') {
        clearRetry(info.taskId)
        await finishTask(info)
        return
      }
      if (state.phase === 'blocked') return
      if (info.cancelled) throw new Error('Task cancelled.')
      if (info.code !== 0) {
        const currentIssue = info.result?.retry && state.currentIssueId
          ? issues.list(info.taskId).find((issue) => issue.id === state.currentIssueId) : undefined
        if (currentIssue?.status === 'review' || currentIssue?.status === 'complete') {
          recordSystemEvent(info.taskId, 'The issue was submitted before the connection failed. Preserving its review state.')
          info = { ...info, code: 0, error: undefined }
        } else {
          if ((!currentIssue || currentIssue.status === 'working') && scheduleRetry(info)) return
          throw new Error(info.error ?? 'Agent failed.')
        }
      }
      clearRetry(info.taskId)
      if (state.phase === 'planning') {
        issues.finishPlanning(info.taskId)
      } else {
        const task = store.getTask(info.taskId)!
        let delivery: Awaited<ReturnType<typeof gitDelivery.finalizeBranch>> | undefined
        let noChanges: VerifiedNoChanges | undefined
        if (task.branchName) {
          finalizing = true
          if (!task.baseCommit) throw new Error('The task has no base commit for finalization.')
          const project = store.getProjects(task.workspaceId).find((entry) => entry.id === task.projectId)
          if (!project || project.path !== state.projectPath) throw new Error('Task project is unavailable')
          store.updateTask(task.id, { deliveryStatus: 'finalizing', deliveryError: undefined })
          notify(task.id)
          delivery = await gitDelivery.finalizeBranch(project.path, task.id, task.branchName, task.baseBranch, task.baseCommit, task.title, {
            check,
            onFinisherCommand: (command) => recordSystemEvent(task.id, command, 'did_not_commit')
          })
          check()
          const issue = issues.list(task.id).find((entry) => entry.id === state.currentIssueId)
          if (issue && !issue.baseCommit) throw new Error('The issue has no base commit for review.')
          if (issue?.baseCommit) {
            const diff = await gitDelivery.getDiff(project.path, issue.baseCommit, delivery.headCommit)
            if (issue.status === 'review' && diff.patch === '') {
              noChanges = { issueId: issue.id, baseCommit: issue.baseCommit, headCommit: delivery.headCommit }
            }
          }
          check()
        }
        // Save the finalized range, aggregate metadata and review phase together.
        store.transaction(() => {
          if (delivery) store.updateTask(task.id, {
            headCommit: delivery.headCommit, filesChanged: delivery.filesChanged,
            additions: delivery.additions, deletions: delivery.deletions, deliveryStatus: 'working'
          })
          if (state.phase === 'recovering') issues.finishRecovery(task.id, delivery?.headCommit, noChanges)
          else issues.finishIssue(task.id, delivery?.headCommit, noChanges)
        }, task.workspaceId)
      }
      const next = store.getTaskExecution(info.taskId)
      if (next?.phase === 'reviewing') {
        // The gate: never hop to the next queued issue before developer review.
        return
      }
      if (next?.phase === 'complete') {
        await finishTask(info)
      } else {
        setImmediate(() => { void startNextTurn(info.taskId) })
      }
    } catch (error) {
      if (!store.getTask(info.taskId)) return
      if (cancelledFinishes.has(info.taskId)) info = { ...info, cancelled: true }
      const message = error instanceof Error ? error.message : String(error)
      const wasRunning = store.getTask(info.taskId)?.status === 'running'
      store.transaction(() => {
        stopTask(info.taskId, message)
        // Commit explicit cancellation with its incidental blocked issue state.
        if (info.cancelled && wasRunning) store.updateTask(info.taskId, { status: 'cancelled' })
        if (finalizing) store.updateTask(info.taskId, { deliveryStatus: 'failed', deliveryError: message })
      }, store.getTask(info.taskId)?.workspaceId)
      if (wasRunning) await finishTask({ ...info, code: 1, error: message }, { finalize: !finalizing })
    } finally {
      finishing.delete(info.taskId)
      cancelledFinishes.delete(info.taskId)
      // Observers must receive a snapshot after the readiness guard is released.
      store.activityChanged()
      notify(info.taskId)
      if (issueReviewReady(info.taskId)) {
        recordSystemEvent(info.taskId, `Issue ${store.getTaskExecution(info.taskId)!.currentIssueId} is awaiting developer review. Approve it or request changes to continue.`)
      }
    }
  }

  agentProcesses.on('exit', (info: ExitInfo) => {
    if (!store.getTask(info.taskId)) void gitDelivery.releaseWorktree(info.taskId)
    void finishTaskTurn(info)
  })

  const requireStoppedTurn = (taskId: string): void => {
    if (starting.has(taskId) || finishing.has(taskId) || agentProcesses.isRunning(taskId)) {
      throw new Error('This task has not finished stopping. Wait and try again.')
    }
  }

  const approveIssue: TaskExecution['approveIssue'] = async (taskId) => {
    requireStoppedTurn(taskId)
    if (!issueReviewReady(taskId)) throw new Error('This task is not ready for issue review')
    const issueId = store.getTaskExecution(taskId)?.currentIssueId
    const state = issues.approveIssue(taskId)
    notify(taskId)
    recordSystemEvent(taskId, `Developer approved issue ${issueId}.`)
    if (state.phase === 'complete') {
      await finishTask({ taskId, code: 0, cancelled: false })
    } else {
      await startNextTurn(taskId)
    }
    return store.getTaskExecution(taskId) ?? state
  }

  const rejectIssue: TaskExecution['rejectIssue'] = (taskId) => {
    requireStoppedTurn(taskId)
    if (!issueReviewReady(taskId)) throw new Error('This task is not ready for issue review')
    const issueId = store.getTaskExecution(taskId)?.currentIssueId
    const state = issues.rejectIssue(taskId)
    notify(taskId)
    recordSystemEvent(taskId, `Developer requested changes on issue ${issueId}. Restarting its turn with the review feedback.`)
    return state
  }

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
    requireStoppedTurn(taskId)
    clearRetry(taskId)
    return issues.resume(taskId)
  }

  const issueReviewReady = (taskId: string): boolean => {
    try {
      requireStoppedTurn(taskId)
      const state = store.getTaskExecution(taskId)
      if (state?.phase !== 'reviewing' || !state.currentIssueId) return false
      const task = store.getTask(taskId)
      if (!task || task.deliveryStatus === 'finalizing' || task.deliveryStatus === 'failed') return false
      if (!task.branchName) return true
      const source = issues.issueDiffSource(taskId, state.currentIssueId)
      return Boolean(source.baseCommit && source.headCommit ||
        !source.baseCommit && !source.headCommit && source.taskBaseCommit && source.taskHeadCommit)
    } catch { return false }
  }

  return { issueReviewReady, initializeTask, resumeTask, stopTask, finishTaskTurn, requireFinishedTask, approveIssue, rejectIssue }
}
