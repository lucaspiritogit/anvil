import type { JSX } from 'react'
import { IS_MAC } from '../keys'
import { useStore } from '../state/store'
import { btn, cn } from '../ui'
import { TaskView } from './TaskView'
import { ProjectOverview } from './ProjectOverview'

export function Workspace(): JSX.Element {
  const projects = useStore((s) => s.projects)
  const activeProjectId = useStore((s) => s.activeProjectId)
  const view = useStore((s) => s.view)
  const tasks = useStore((s) => s.tasks)
  const addProject = useStore((s) => s.addProject)
  const sidebarCollapsed = useStore((s) => s.sidebarCollapsed)

  const project = projects.find((p) => p.id === activeProjectId)
  const dragStrip = IS_MAC && sidebarCollapsed

  if (!project) {
    return (
      <main className="flex flex-col min-w-0 h-full">
        {dragStrip && <DragStrip />}
        <div className="grid place-content-center justify-items-center gap-2.5 h-full text-center">
          <h1 className="text-lg font-semibold">Add a project</h1>
          <p className="max-w-[360px] mb-2 text-dim">
            Point Anvil at a folder to start dispatching agents.
          </p>
          <button className={btn.primary} onClick={() => void addProject()}>
            Choose folder
          </button>
        </div>
      </main>
    )
  }

  const activeTask = view.kind === 'task' ? tasks.find((r) => r.id === view.taskId) : undefined

  const issueId = view.kind === 'task' ? view.issueId : undefined

  return (
    <main className="flex flex-col min-w-0 min-h-0 h-full overflow-hidden">
      {dragStrip && <DragStrip />}
      <section className="relative flex-1 min-w-0 min-h-0 overflow-hidden">
        {(view.kind === 'home' || !activeTask) && (
          <ProjectOverview project={project} />
        )}
        {activeTask && <TaskView key={JSON.stringify([activeTask.id, issueId])} task={activeTask} issueId={issueId} />}
      </section>
    </main>
  )
}

/*
 * On macOS the traffic lights normally sit over the sidebar's brand row. With
 * the sidebar collapsed they land here instead, so a slim strip takes over as
 * the window's drag handle and keeps the gutter clear.
 */
function DragStrip(): JSX.Element {
  return (
    <div className={cn('drag-region flex shrink-0 items-center h-11 pl-[78px] text-[11px] font-semibold tracking-[0.12em] text-dim border-b border-line')}>
      ANVIL
    </div>
  )
}
