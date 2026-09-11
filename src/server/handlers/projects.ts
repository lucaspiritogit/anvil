import type { HandlerRegistry } from '../handler-registry'
import { randomUUID } from 'node:crypto'
import { basename, isAbsolute } from 'node:path'
import { stat } from 'node:fs/promises'
import type { ProjectMemory } from '../memory/project-memory'
import type { TaskContext } from '../tasks/context'
import type { TaskExecution } from '../tasks/task-execution'
import type { Project } from '../../shared/types'
import { listProjectFiles, projectFileError } from '../project-files'

interface ProjectHandlerDependencies extends Pick<TaskContext, 'store' | 'gitDelivery' | 'agentProcesses'> {
  stopTask: TaskExecution['stopTask']
  projectMemory?: ProjectMemory
  projectsChanged?(workspaceId: string): void
}

export function registerProjectHandlers(ipc: HandlerRegistry, {
  store, gitDelivery, agentProcesses, stopTask, projectMemory, projectsChanged
}: ProjectHandlerDependencies): void {
  ipc.handle('projects:list', () => store.getProjects())
  ipc.handle('projects:files', async ({ projectId }) => {
    const project = store.getProjects().find((item) => item.id === projectId)
    if (!project) return projectFileError(projectId, 'project-not-found', 'Project not found.')
    const result = await listProjectFiles(project)
    // Removal or replacement during a scan must not return a stale project listing.
    if (!store.getProjects().some((item) => item.id === projectId && item.path === project.path)) {
      return projectFileError(projectId, 'project-not-found', 'Project not found.')
    }
    return result
  })

  ipc.handle('projects:add', async ({ path }) => {
    const workspaceId = store.getActiveWorkspace().id
    if (!isAbsolute(path) || !(await stat(path)).isDirectory()) throw new Error('Project path must be an absolute directory')
    const project: Project = {
      id: randomUUID(),
      name: basename(path) || path,
      path,
      createdAt: Date.now(),
      monthlyTokenLimit: null,
      monthlyCostLimitUsd: null,
      finishOnPush: false,
      gitPlatform: 'github'
    }
    const added = store.addProject(project, workspaceId)
    projectsChanged?.(workspaceId)
    return added
  })

  ipc.handle('projects:remove', async (id: string) => {
    const workspaceId = store.getActiveWorkspace().id
    const memory = projectMemory && 'forWorkspace' in projectMemory
      ? (projectMemory as import('../memory/workspace-project-memory').WorkspaceProjectMemory).forWorkspace(workspaceId) : projectMemory
    const projectTasks = store.getTasks(workspaceId).filter((task) => task.projectId === id)
    store.transaction(() => {
      for (const task of projectTasks) stopTask(task.id, 'Anvil project removed.')
      store.removeProject(id, workspaceId)
    }, workspaceId)
    for (const task of projectTasks) {
      if (agentProcesses.isRunning(task.id)) agentProcesses.cancel(task.id)
      else void gitDelivery.releaseWorktree(task.id)
    }
    if (memory) {
      try {
        await memory.forgetProject(id)
      } catch (error) {
        console.warn(`Could not remove project memory for project ${id}:`, error)
      }
    }
    projectsChanged?.(workspaceId)
    return store.getProjects(workspaceId)
  })

  ipc.handle('projects:update', (input) => {
    const workspaceId = input.workspaceId ?? store.getActiveWorkspace().id
    const project = store.updateProject(input.id, {
      monthlyTokenLimit: input.monthlyTokenLimit,
      monthlyCostLimitUsd: input.monthlyCostLimitUsd,
      finishOnPush: input.finishOnPush
    }, workspaceId)
    projectsChanged?.(workspaceId)
    return project
  })

  ipc.handle('projects:reveal', (id) => {
    const project = store.getProjects().find((item) => item.id === id)
    if (!project) throw new Error('Project not found')
    return project.path
  })

  ipc.handle('projects:git-status', async (id: string) => {
    const project = store.getProjects().find((item) => item.id === id)
    if (!project) throw new Error('Project not found')
    return gitDelivery.status(project.path)
  })

  ipc.handle('projects:git-init', async (id: string) => {
    const project = store.getProjects().find((item) => item.id === id)
    if (!project) throw new Error('Project not found')
    return gitDelivery.init(project.path)
  })

  ipc.handle('projects:branches', async (id) => {
    const project = store.getProjects().find((item) => item.id === id)
    if (!project) throw new Error('Project not found')
    return gitDelivery.branches(project.path)
  })

  ipc.handle('projects:checkout', async ({ projectId, branchName }) => {
    const workspaceId = store.getActiveWorkspace().id
    const project = store.getProjects().find((item) => item.id === projectId)
    if (!project) throw new Error('Project not found')
    const result = await gitDelivery.switchProjectBranch(project.path, branchName)
    projectsChanged?.(workspaceId)
    return result
  })
}
