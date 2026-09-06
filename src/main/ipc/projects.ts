import { BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { randomUUID } from 'node:crypto'
import { basename } from 'node:path'
import type { ProjectMemory } from '../memory/project-memory'
import type { TaskContext } from '../tasks/context'
import type { TaskExecution } from '../tasks/task-execution'
import type { TerminalManager } from '../terminal'
import type { Project } from '../../shared/types'

interface ProjectHandlerDependencies extends Pick<TaskContext, 'store' | 'gitDelivery' | 'agentProcesses'> {
  stopTask: TaskExecution['stopTask']
  terminals: TerminalManager
  projectMemory?: ProjectMemory
  getWindow(): BrowserWindow | null
}

export function registerProjectHandlers({
  store, gitDelivery, agentProcesses, stopTask, terminals, projectMemory, getWindow
}: ProjectHandlerDependencies): void {
  ipcMain.handle('projects:list', () => store.getProjects())

  ipcMain.handle('projects:add', async () => {
    const window = getWindow()
    const result = window
      ? await dialog.showOpenDialog(window, { properties: ['openDirectory'] })
      : await dialog.showOpenDialog({ properties: ['openDirectory'] })

    if (result.canceled || !result.filePaths.length) return null

    const path = result.filePaths[0]
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
    return store.addProject(project)
  })

  ipcMain.handle('projects:remove', async (_event, id: string) => {
    terminals.dispose(id)
    const projectTasks = store.getTasks().filter((task) => task.projectId === id)
    for (const task of projectTasks) stopTask(task.id, 'Anvil project removed.')
    store.removeProject(id)
    for (const task of projectTasks) {
      if (agentProcesses.isRunning(task.id)) agentProcesses.cancel(task.id)
    }
    if (projectMemory) {
      try {
        await projectMemory.forgetProject(id)
      } catch (error) {
        console.warn(`Could not remove project memory for project ${id}:`, error)
      }
    }
    return store.getProjects()
  })

  ipcMain.handle(
    'projects:update',
    (
      _event,
      input: {
        id: string
        monthlyTokenLimit: number | null
        monthlyCostLimitUsd: number | null
        finishOnPush: boolean
      }
    ) => store.updateProject(input.id, input)
  )

  ipcMain.handle('projects:reveal', (_event, path: string) => shell.openPath(path))

  ipcMain.handle('projects:git-status', async (_event, id: string) => {
    const project = store.getProjects().find((item) => item.id === id)
    if (!project) throw new Error('Project not found')
    return gitDelivery.status(project.path)
  })

  ipcMain.handle('projects:git-init', async (_event, id: string) => {
    const project = store.getProjects().find((item) => item.id === id)
    if (!project) throw new Error('Project not found')
    return gitDelivery.init(project.path)
  })
}
