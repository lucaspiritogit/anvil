import type { JSX } from 'react'
import { IS_MAC } from '../keys'
import { useStore } from '../state/store'
import { btn, cn } from '../ui'
import { TerminalPane } from './TerminalPane'
import { TaskView } from './TaskView'
import { ProjectOverview } from './ProjectOverview'
import { openTaskContextMenu } from './TaskContextMenu'

const TAB = 'max-w-[260px] px-3 py-1.5 rounded-md overflow-hidden text-ellipsis whitespace-nowrap'

export function Workspace(): JSX.Element {
  const projects = useStore((s) => s.projects)
  const activeProjectId = useStore((s) => s.activeProjectId)
  const view = useStore((s) => s.view)
  const tasks = useStore((s) => s.tasks)
  const showTerminal = useStore((s) => s.showTerminal)
  const showHome = useStore((s) => s.showHome)
  const openTask = useStore((s) => s.openTask)
  const setNewTaskOpen = useStore((s) => s.setNewTaskOpen)
  const setSettingsOpen = useStore((s) => s.setSettingsOpen)
  const addProject = useStore((s) => s.addProject)
  const sidebarCollapsed = useStore((s) => s.sidebarCollapsed)

  const project = projects.find((p) => p.id === activeProjectId)

  if (!project) {
    return (
      <main className="flex flex-col min-w-0 h-full">
        <div className="grid place-content-center justify-items-center gap-2.5 h-full text-center">
          <h1 className="text-lg font-semibold">Add a project</h1>
          <p className="max-w-[360px] mb-2 text-dim">
            Point Anvil at a folder to get a terminal and start dispatching agents.
          </p>
          <button className={btn.primary} onClick={() => void addProject()}>
            Choose folder
          </button>
        </div>
      </main>
    )
  }

  const activeTask = view.kind === 'task' ? tasks.find((r) => r.id === view.taskId) : undefined
  const projectTasks = tasks.filter((task) => task.projectId === project.id)

  return (
    <main className="flex flex-col min-w-0 min-h-0 h-full overflow-hidden">
      {/*
       * On macOS the traffic lights normally sit over the sidebar's brand row.
       * With the sidebar collapsed they land here instead, so the gutter moves
       * to the tab bar and the row doubles as the window's drag handle.
       */}
      <header
        className={cn(
          'flex shrink-0 gap-4 items-center justify-between pr-3.5 py-2 border-b border-line',
          IS_MAC && 'drag-region transition-[padding-left] duration-[180ms] ease-[ease] motion-reduce:transition-none',
          IS_MAC && sidebarCollapsed ? 'pl-[78px]' : 'pl-3.5'
        )}
      >
        <div className="flex gap-1 min-w-0">
          <button
            className={cn(
              TAB,
              'no-drag',
              view.kind === 'home' ? 'text-fg bg-hover' : 'text-dim hover:bg-hover'
            )}
            onClick={showHome}
          >
            Overview
          </button>
          <button
            className={cn(
              TAB,
              'no-drag',
              view.kind === 'terminal' ? 'text-fg bg-hover' : 'text-dim hover:bg-hover'
            )}
            onClick={showTerminal}
          >
            Terminal
          </button>
          {activeTask && (
            <button
              className={cn(TAB, 'no-drag text-fg bg-hover')}
              onContextMenu={(event) => openTaskContextMenu(event, activeTask.id)}
            >
              {activeTask.title}
            </button>
          )}
        </div>

        <div className="flex gap-3 items-center min-w-0">
          <span
            className="max-w-[320px] overflow-hidden font-mono text-[11px] text-dim text-ellipsis whitespace-nowrap [direction:rtl]"
            title={project.path}
          >
            {project.path}
          </span>
          <button className={cn(btn.primary, 'no-drag')} onClick={() => setNewTaskOpen(true)}>
            Start new task
          </button>
        </div>
      </header>

      <section className="relative flex-1 min-w-0 min-h-0 overflow-hidden">
        <div className={view.kind === 'terminal' ? 'h-full' : 'hidden'}>
          <TerminalPane projectId={project.id} cwd={project.path} />
        </div>
        {view.kind === 'home' && (
          <ProjectOverview
            project={project}
            tasks={projectTasks}
            onOpenTask={(taskId) => void openTask(taskId)}
            onStartTask={() => setNewTaskOpen(true)}
            onOpenSettings={() => setSettingsOpen(true)}
          />
        )}
        {activeTask && <TaskView task={activeTask} />}
      </section>
    </main>
  )
}
