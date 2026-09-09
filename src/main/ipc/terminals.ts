import type { RendererIpc } from '../renderer-security'
import type { Store } from '../store'
import type { TerminalManager } from '../terminal'

export function registerTerminalHandlers(ipc: RendererIpc, terminals: TerminalManager, store: Store): void {
  const requireProject = (projectId: string) => {
    const project = store.getProjects().find((item) => item.id === projectId)
    if (!project) throw new Error('Project not found')
    return project
  }
  const requireTerminal = (projectId: string): void => {
    requireProject(projectId)
    if (!terminals.has(projectId)) throw new Error('This project has no terminal')
  }

  ipc.handle('terminal:ensure', (_event, input) => {
    const project = requireProject(input.projectId)
    terminals.create(project.id, project.path, input.cols, input.rows)
    return terminals.snapshot(project.id)
  })

  ipc.on('terminal:write', (_event, input) => {
    requireTerminal(input.projectId)
    terminals.write(input.projectId, input.data)
  })

  ipc.on('terminal:resize', (_event, input) => {
    requireTerminal(input.projectId)
    terminals.resize(input.projectId, input.cols, input.rows)
  })
}
