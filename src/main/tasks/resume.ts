import { GIT_SYSTEM_PROMPT, getAgent } from '../agents/registry'
import type { Task, TaskExecutionState } from '../../shared/types'
import type { TaskContext } from './context'

interface ResumeOptions {
  check: (expected?: Task) => Task
  validate: (task: Task) => void
  prompt: (task: Task, state: TaskExecutionState | undefined) => string
  gitInstructions?: boolean
  resumeExecution?: (taskId: string) => TaskExecutionState
}

/** Share location, saved settings and rollback for every stopped-task follow-up. */
export async function resumeTaskTurn(
  { store, agentProcesses, gitDelivery, send }: TaskContext,
  { check, validate, prompt, resumeExecution, gitInstructions = true }: ResumeOptions
): Promise<Task> {
  const task = check()
  validate(task)
  if (task.settledAt !== undefined) throw new Error('This task is settled and cannot be resumed')
  const agent = getAgent(task.agentId)
  if (!agent) throw new Error(`Unknown agent: ${task.agentId}`)
  if (task.sessionId && !agent.executionProtocol && !agent.resumeArgs) throw new Error('This agent cannot resume its saved session')
  const project = store.getProjects().find((item) => item.id === task.projectId)
  if (!project) throw new Error('Project not found')
  const guard = (): Task => {
    const current = check()
    validate(current)
    if (agentProcesses.isRunning(task.id)) throw new Error('This task is already running')
    return current
  }
  const savedState = store.getTaskExecution(task.id)
  const images = savedState?.hasImages ? store.taskImages.read(task.id) : undefined
  if (savedState?.hasImages && !images && !task.sessionId) {
    throw new Error('The original task images were cleared. Start a new task and attach the images again.')
  }
  try {
    let location: Partial<Task> = { cwd: project.path }
    if (task.branchName) {
      const checkout = await gitDelivery.checkoutBranch(project.path, task.id, task.branchName, task.baseBranch, guard)
      location = { cwd: checkout.cwd }
    } else if (task.deliveryStatus !== 'unavailable' && (await gitDelivery.status(project.path)).isRepository) {
      guard()
      const prepared = await gitDelivery.prepareBranch(project.path, task.id, task.title, guard)
      location = { cwd: prepared.cwd, baseCommit: prepared.baseCommit,
        baseBranch: prepared.baseBranch, branchName: prepared.branchName }
    }
    const current = guard()
    const previousState = store.getTaskExecution(task.id)
    let running: Task | undefined
    try {
      const state = resumeExecution ? resumeExecution(task.id) : previousState
      const message = prompt(current, state)
      const managed = Boolean(location.branchName ?? current.branchName)
      const executionPrompt = managed && gitInstructions ? `${GIT_SYSTEM_PROMPT}\n\n${message}` : message
      guard()
      running = store.updateTask(task.id, {
        ...location, status: 'running', endedAt: undefined, exitCode: null, error: undefined,
        deliveryStatus: managed ? 'working' : 'unavailable', deliveryError: undefined
      })!
      // No scheduled callback: startup errors return to the invoking handler.
      await agentProcesses.startResumed({
        beforeDispatch: () => { check(running) },
        taskId: task.id, issueId: state?.currentIssueId ?? undefined, agent, cwd: running.cwd,
        projectPath: project.path, model: current.model, reasoningEffort: state?.reasoningEffort,
        resumeSessionId: current.sessionId,
        prompt: executionPrompt,
        images,
        resumeFallbackPrompt: resumeExecution && state?.phase !== 'complete' && (!state?.hasImages || images) ? [
          'The previous agent conversation is unavailable. Recover from the saved task plan and existing branch.',
          'Inspect the current files, Git history, and Valence issue details before making changes. Earlier work may already be committed; preserve it and do not repeat completed issues.',
          executionPrompt
        ].join('\n\n') : undefined
      })
      send('task:updated', store.getTask(task.id) ?? running)
      return store.getTask(task.id) ?? running
    } catch (error) {
      // Do not resurrect a deleted task or overwrite a newer lifecycle transition.
      const latest = store.getTask(task.id)
      if (latest && (!running || latest.status === 'running' && latest.deliveryStatus === running.deliveryStatus)) {
        const restored = store.updateTask(task.id, { ...current, sessionId: latest.sessionId })!
        if (previousState) store.saveTaskExecution(previousState)
        send('task:updated', restored)
      }
      throw error
    }
  } catch (error) {
    if (!store.getTask(task.id)) await gitDelivery.releaseWorktree(task.id)
    throw error
  }
}
