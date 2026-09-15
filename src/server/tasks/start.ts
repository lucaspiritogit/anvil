import type { Task } from '../../shared/types'
import { getAgent, LOCAL_CHECKOUT_GIT_SYSTEM_PROMPT } from '../agents/registry'
import { resolveWorkspaceExecution } from '../agents/workspace-execution'
import { planningPrompt } from '../agents/task-prompts'
import { quickTaskPrompt } from '../agents/task-prompts'
import { taskStyle } from '../../shared/task-style'
import type { TaskMemory } from '../memory/task-memory'
import type { RecordSystemEvent, TaskContext } from './context'
import type { TaskExecution } from './task-execution'
import { requireStackParent, stackParentIsReady } from './task-stacks'
import { taskCheckoutMode } from '../../shared/task-checkout'
import { requireProjectCheckoutAvailable, usesManagedWorktree } from './checkout'

interface TaskStartContext extends TaskContext {
  recordSystemEvent: RecordSystemEvent
  stopTask: TaskExecution['stopTask']
  promptWithProjectMemory: TaskMemory['promptWithProjectMemory']
}

/** Preparing tasks have no checkout yet, so a stack always starts at its parent's final head. */
export function registerTaskStarts(context: TaskStartContext): (taskId: string) => Promise<Task> {
  const { store, agentProcesses, gitDelivery, send, recordSystemEvent, stopTask, promptWithProjectMemory } = context
  const starting = new Set<string>()
  let closing = false
  let scheduled = false
  agentProcesses.on('closing', () => { closing = true })

  const startTask = async (taskId: string): Promise<Task> => {
    const task = store.getTask(taskId)
    if (!task) throw new Error('Task was deleted')
    if (closing || starting.has(taskId) || task.status !== 'running' || task.deliveryStatus !== 'preparing' ||
      !stackParentIsReady(context, task)) return task
    starting.add(taskId)
    try {
      const requireRunningTask = (): void => {
        const current = store.getTask(task.id)
        if (!current) throw new Error('Task was deleted')
        if (closing || current.status !== 'running') throw new Error('Task stopped during preparation')
        if (!stackParentIsReady(context, current)) throw new Error('Wait for the parent task to finish before starting')
        requireProjectCheckoutAvailable(store, current)
      }
      try {
        const project = store.getProjects(task.workspaceId).find((entry) => entry.id === task.projectId)
        if (!project) throw new Error('Project not found')
        const agent = getAgent(task.agentId)
        if (!agent) throw new Error(`Unknown agent: ${task.agentId}`)
        const state = store.getTaskExecution(task.id)
        if (!state) throw new Error('Task execution not found')
        const images = state.hasImages ? store.taskImages.read(task.id) : undefined
        if (state.hasImages && !images) throw new Error('The original task images were cleared')
        const workspace = resolveWorkspaceExecution(store, task.workspaceId)
        const style = taskStyle(task)
        // Without Git there is no task branch or diff. Run directly in the project folder.
        const git = await gitDelivery.status(project.path)
        requireRunningTask()
        if (taskCheckoutMode(task) === 'local') {
          const localTask = store.updateTask(task.id, {
            cwd: project.path,
            deliveryStatus: 'unavailable'
          })!
          send('task:updated', localTask)
          recordSystemEvent(task.id, `Using local checkout: ${project.path}`)
          const enrichedPrompt = await promptWithProjectMemory(project.id, task.prompt, task.workspaceId)
          const taskPrompt = style === 'work' ? planningPrompt(enrichedPrompt, state) : quickTaskPrompt(style, enrichedPrompt)
          const prompt = git.isRepository && style === 'work' ? `${LOCAL_CHECKOUT_GIT_SYSTEM_PROMPT}\n\n${taskPrompt}` : taskPrompt
          requireRunningTask()
          agentProcesses.start({
            workspace,
            taskId: task.id,
            agent,
            prompt,
            images,
            model: task.model,
            reasoningEffort: state.reasoningEffort,
            cwd: project.path,
            projectPath: project.path,
            issueTracker: style === 'work',
            beforeDispatch: requireRunningTask
          })
          return localTask
        }
        if (!git.isRepository) {
          if (task.parentTaskId) throw new Error('Stacked tasks require a Git repository')
          requireProjectCheckoutAvailable(store, task)
          const unmanagedTask = store.updateTask(task.id, {
            cwd: project.path,
            deliveryStatus: 'unavailable'
          })!
          send('task:updated', unmanagedTask)
          const enrichedPrompt = await promptWithProjectMemory(project.id, task.prompt, task.workspaceId)
          const prompt = style === 'work' ? planningPrompt(enrichedPrompt, state) : quickTaskPrompt(style, enrichedPrompt)
          requireRunningTask()
          agentProcesses.start({
            workspace,
            taskId: task.id,
            agent,
            prompt,
            images,
            model: task.model,
            reasoningEffort: state.reasoningEffort,
            cwd: project.path,
            projectPath: project.path,
            issueTracker: style === 'work',
            beforeDispatch: requireRunningTask
          })
          return unmanagedTask
        }

        const parentId = store.getTask(task.id)?.parentTaskId
        const parent = parentId ? requireStackParent(store, task, parentId) : undefined
        const base = parent
          ? await gitDelivery.stackBase(project.path, parent.branchName)
          : task.startBase
            ? await gitDelivery.resolveWorktreeBase(project.path, task.startBase)
            : undefined
        const prepared = await gitDelivery.prepareBranch(project.path, task.id, () => {
          requireRunningTask()
          if (parentId) requireStackParent(store, task, parentId)
        }, base)
        const preparedTask = store.updateTask(task.id, {
          cwd: prepared.cwd,
          ...(store.getTask(task.id)?.status === 'running' ? { deliveryStatus: 'working' as const } : {}),
          baseBranch: parent ? requireStackParent(store, task, parent.id).branchName : prepared.baseBranch,
          branchName: prepared.branchName,
          baseCommit: prepared.baseCommit
        })!
        send('task:updated', preparedTask)
        requireRunningTask()
        recordSystemEvent(task.id, `Task checkout: ${prepared.cwd}\nBranch: ${prepared.branchName}\nStarting commit: ${prepared.baseCommit}`)
        if (prepared.initializedRepository) {
          recordSystemEvent(task.id, 'Created the repository initial commit.')
        }
        // Memory enriches agent input; it must not hold up branch creation.
        const enrichedPrompt = await promptWithProjectMemory(project.id, task.prompt, task.workspaceId)
        const prompt = style === 'work' ? planningPrompt(enrichedPrompt, state) : quickTaskPrompt(style, enrichedPrompt)
        requireRunningTask()
        agentProcesses.start({
          workspace,
          taskId: task.id,
          agent,
          prompt,
          images,
          model: task.model,
          reasoningEffort: state.reasoningEffort,
          cwd: prepared.cwd,
          projectPath: project.path,
          issueTracker: style === 'work',
          beforeDispatch: requireRunningTask
        })
        return preparedTask
      } catch (error) {
        store.taskImages.remove(task.id)
        const current = store.getTask(task.id)
        if (!current) {
          if (usesManagedWorktree(task)) await gitDelivery.releaseWorktree(task.id)
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
        send('task:updated', failed)
        return failed
      }
    } finally {
      starting.delete(taskId)
    }
  }

  const schedule = (): void => {
    if (closing || scheduled) return
    scheduled = true
    setImmediate(() => {
      scheduled = false
      if (closing) return
      for (const task of store.getTasks()) {
        if (task.status !== 'running' || task.deliveryStatus !== 'preparing' || task.branchName ||
          task.sessionId || store.getTaskExecution(task.id)?.phase !== 'planning') continue
        void startTask(task.id).catch((error) => console.warn('Could not start queued task:', error))
      }
    })
  }
  store.subscribeActivity(schedule)
  schedule()
  return startTask
}
