import type { HandlerRegistry } from '../handler-registry'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { mkdir, readdir, rm, stat } from 'node:fs/promises'
import type { ProjectMemory } from '../memory/project-memory'
import type { TaskContext } from '../tasks/context'
import type { TaskExecution } from '../tasks/task-execution'
import type { Project } from '../../shared/types'
import { listProjectFiles, projectFileError } from '../project-files'
import { usesManagedWorktree, usesProjectCheckout } from '../tasks/checkout'
import { taskOperationKind } from '../tasks/operations'
import { git } from '../git/command'

interface ProjectHandlerDependencies extends Pick<TaskContext, 'store' | 'gitDelivery' | 'agentProcesses'> {
  stopTask: TaskExecution['stopTask']
  deferTaskCleanup: TaskExecution['deferTaskCleanup']
  skipTaskCleanup: TaskExecution['skipTaskCleanup']
  projectMemory?: ProjectMemory
  projectsChanged?(workspaceId: string): void
  cloneRepository?(url: string, destination: string): Promise<void>
}

function cloneUrl(value: string): { url: string; name: string } {
  let parsed: URL
  try {
    parsed = new URL(value.trim())
  } catch {
    throw new Error('Enter a valid HTTPS Git repository URL')
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error('Enter an HTTPS Git repository URL without credentials, a query, or a fragment')
  }
  const encodedName = parsed.pathname.replace(/\/+$/, '').split('/').at(-1) ?? ''
  let name: string
  try {
    name = decodeURIComponent(encodedName).replace(/\.git$/i, '')
  } catch {
    throw new Error('The Git repository URL contains an invalid repository name')
  }
  if (!name || name === '.' || name === '..' || name.length > 255 || /[<>:"/\\|?*\x00-\x1f]/.test(name) || /[. ]$/.test(name)) {
    throw new Error('The Git repository URL contains an invalid repository name')
  }
  return { url: parsed.href, name }
}

async function cloneHttpsRepository(url: string, destination: string): Promise<void> {
  await git(dirname(destination), ['clone', '--', url, destination], [0], {
    GIT_TERMINAL_PROMPT: '0',
    GCM_INTERACTIVE: 'Never'
  })
}

export function registerProjectHandlers(ipc: HandlerRegistry, {
  store, gitDelivery, agentProcesses, stopTask, deferTaskCleanup, skipTaskCleanup, projectMemory, projectsChanged,
  cloneRepository = cloneHttpsRepository
}: ProjectHandlerDependencies): void {
  const requireCheckoutAvailable = (projectId: string): void => {
    if (store.getTasks().some((task) => task.projectId === projectId &&
      (task.deliveryStatus === 'merge_conflict' || task.mergeConflict))) {
      throw new Error('Resolve or abort the paused task merge before changing this project checkout')
    }
    const conflict = store.getTasks().find((task) => task.projectId === projectId && task.status === 'running' && usesProjectCheckout(task))
    if (!conflict) return
    throw new Error('Wait for the active task using this project checkout to finish')
  }
  ipc.handle('projects:list', () => store.getProjects())
  ipc.handle('projects:browse', async ({ path }) => {
    if (path && !isAbsolute(path)) throw new Error('Project browser paths must be absolute')
    const directory = resolve(path?.trim() || homedir())
    if (!(await stat(directory)).isDirectory()) throw new Error('Project browser path must be a directory')
    const entries = await readdir(directory, { withFileTypes: true })
    const directories = (await Promise.all(entries.map(async (entry) => {
      const entryPath = join(directory, entry.name)
      if (entry.isDirectory()) return { name: entry.name, path: entryPath }
      if (!entry.isSymbolicLink()) return null
      try {
        return (await stat(entryPath)).isDirectory() ? { name: entry.name, path: entryPath } : null
      } catch {
        return null
      }
    }))).filter((entry): entry is { name: string; path: string } => entry !== null)
      .sort((left, right) => left.name.localeCompare(right.name))
    const parent = dirname(directory)
    return { path: directory, parentPath: parent === directory ? null : parent, directories }
  })
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

  ipc.handle('projects:add', async ({ path, workspaceId = store.getActiveWorkspace().id }) => {
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

  ipc.handle('projects:clone', async ({ url, workspaceId = store.getActiveWorkspace().id }) => {
    const repository = cloneUrl(url)
    const root = join(store.getWorkspaceDirectory(workspaceId), 'projects')
    const destination = join(root, repository.name)
    await mkdir(root, { recursive: true, mode: 0o700 })
    try {
      await mkdir(destination, { mode: 0o700 })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new Error(`A project folder named ${repository.name} already exists in this workspace`)
      }
      throw error
    }
    try {
      await cloneRepository(repository.url, destination)
      const project: Project = {
        id: randomUUID(),
        name: repository.name,
        path: destination,
        createdAt: Date.now(),
        monthlyTokenLimit: null,
        monthlyCostLimitUsd: null,
        finishOnPush: false,
        gitPlatform: 'github'
      }
      const added = store.addProject(project, workspaceId)
      projectsChanged?.(workspaceId)
      return added
    } catch (error) {
      await rm(destination, { recursive: true, force: true })
      throw error
    }
  })

  ipc.handle('projects:remove', async (id: string) => {
    const workspaceId = store.getActiveWorkspace().id
    const project = store.getProjects(workspaceId).find((entry) => entry.id === id)
    const memory = projectMemory && 'forWorkspace' in projectMemory
      ? (projectMemory as import('../memory/workspace-project-memory').WorkspaceProjectMemory).forWorkspace(workspaceId) : projectMemory
    const projectTasks = store.getTasks(workspaceId).filter((task) => task.projectId === id)
    if (projectTasks.some((task) => task.deliveryStatus === 'merge_conflict' || task.mergeConflict)) {
      throw new Error('Abort the paused task merge before removing this project')
    }
    if (projectTasks.some((task) => taskOperationKind(store, task.id) === 'merge')) {
      throw new Error('Wait for the task merge attempt to finish before removing this project')
    }
    for (const task of projectTasks) {
      if (project && task.branchName && usesManagedWorktree(task) && agentProcesses.isRunning(task.id)) deferTaskCleanup(task.id, project.path, task.branchName)
      else if (!usesManagedWorktree(task) && agentProcesses.isRunning(task.id)) skipTaskCleanup(task.id)
    }
    store.transaction(() => {
      for (const task of projectTasks) stopTask(task.id, 'Anvil project removed.')
      store.removeProject(id, workspaceId)
    }, workspaceId)
    for (const task of projectTasks) {
      if (agentProcesses.isRunning(task.id)) agentProcesses.cancel(task.id)
      else if (usesManagedWorktree(task)) {
        if (project && task.branchName) void gitDelivery.releaseWorktree(project.path, task.id, task.branchName)
        else void gitDelivery.releaseWorktree(task.id)
      }
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
    requireCheckoutAvailable(id)
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
    requireCheckoutAvailable(projectId)
    const result = await gitDelivery.switchProjectBranch(project.path, branchName)
    projectsChanged?.(workspaceId)
    return result
  })
}
