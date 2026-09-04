import type { JSX } from 'react'
import { useStore } from '../state/store'
import { TerminalPane } from './TerminalPane'
import { RunView } from './RunView'
import { HomeView } from './HomeView'

export function Workspace(): JSX.Element {
  const projects = useStore((s) => s.projects)
  const activeProjectId = useStore((s) => s.activeProjectId)
  const view = useStore((s) => s.view)
  const runs = useStore((s) => s.runs)
  const showTerminal = useStore((s) => s.showTerminal)
  const showHome = useStore((s) => s.showHome)
  const openRun = useStore((s) => s.openRun)
  const setNewTaskOpen = useStore((s) => s.setNewTaskOpen)
  const setSettingsOpen = useStore((s) => s.setSettingsOpen)
  const addProject = useStore((s) => s.addProject)

  const project = projects.find((p) => p.id === activeProjectId)

  if (!project) {
    return (
      <main className="workspace">
        <div className="blank">
          <h1>Add a project</h1>
          <p>Point Anvil at a folder to get a terminal and start dispatching agents.</p>
          <button className="primary-btn" onClick={() => void addProject()}>
            Choose folder
          </button>
        </div>
      </main>
    )
  }

  const activeRun = view.kind === 'run' ? runs.find((r) => r.id === view.runId) : undefined
  const projectRuns = runs.filter((run) => run.projectId === project.id)

  return (
    <main className="workspace">
      <header className="topbar">
        <div className="tabs">
          <button className={`tab ${view.kind === 'home' ? 'tab-active' : ''}`} onClick={showHome}>
            Overview
          </button>
          <button
            className={`tab ${view.kind === 'terminal' ? 'tab-active' : ''}`}
            onClick={showTerminal}
          >
            Terminal
          </button>
          {activeRun && <button className="tab tab-active">{activeRun.title}</button>}
        </div>

        <div className="topbar-right">
          <span className="path" title={project.path}>
            {project.path}
          </span>
          <button className="primary-btn" onClick={() => setNewTaskOpen(true)}>
            Start new task
          </button>
        </div>
      </header>

      <section className="pane">
        <div className={view.kind === 'terminal' ? 'fill' : 'hidden'}>
          <TerminalPane projectId={project.id} cwd={project.path} />
        </div>
        {view.kind === 'home' && (
          <HomeView
            project={project}
            runs={projectRuns}
            onOpenRun={(runId) => void openRun(runId)}
            onStartTask={() => setNewTaskOpen(true)}
            onOpenSettings={() => setSettingsOpen(true)}
          />
        )}
        {activeRun && <RunView run={activeRun} />}
      </section>
    </main>
  )
}
