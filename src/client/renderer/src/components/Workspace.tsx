import type { JSX, RefObject } from 'react'
import { DEFAULT_FONT_SIZE, normalizeFontSize } from '@shared/appearance'
import { IS_MAC } from '../keys'
import { Icon } from '../icons'
import { useStore } from '../state/store'
import { cn } from '../ui'
import { TaskView } from './TaskView'
import { ProjectOverview } from './ProjectOverview'
import { AnalyticsPage } from './AnalyticsPage'
import { WorkspaceUsageLimits } from './WorkspaceUsageLimits'

export function Workspace({ mobileNavigation, mobileNavigationOpen, navigationButtonRef, onToggleNavigation }: {
  mobileNavigation: boolean
  mobileNavigationOpen: boolean
  navigationButtonRef: RefObject<HTMLButtonElement | null>
  onToggleNavigation: () => void
}): JSX.Element {
  const projects = useStore((s) => s.projects)
  const activeProjectId = useStore((s) => s.activeProjectId)
  const view = useStore((s) => s.view)
  const tasks = useStore((s) => s.tasks)
  const sidebarCollapsed = useStore((s) => s.sidebarCollapsed)
  const fontSize = useStore((s) => s.settings?.fontSize)

  const project = projects.find((p) => p.id === activeProjectId)
  const scale = normalizeFontSize(fontSize) / DEFAULT_FONT_SIZE

  const activeTask = view.kind === 'task' ? tasks.find((r) => r.id === view.taskId) : undefined

  const overview = view.kind === 'home' || view.kind === 'task' && !activeTask
  const page = view.kind !== 'task' || !activeTask

  return (
    <main className={cn('relative flex flex-col min-w-0 min-h-0 h-full overflow-hidden',
      // Keep the overview centered in the full window, with fixed clearance for
      // traffic lights even when its content needs to scroll in a short window.
      (IS_MAC || sidebarCollapsed || mobileNavigation) && page && 'py-11'
    )}>
      {(mobileNavigation || sidebarCollapsed) && (page
        ? <div className="absolute inset-x-0 top-0"><NavigationHeader scale={scale} expanded={mobileNavigationOpen}
          mobileNavigation={mobileNavigation} buttonRef={navigationButtonRef} onToggle={onToggleNavigation} /></div>
        : <NavigationHeader scale={scale} expanded={mobileNavigationOpen} mobileNavigation={mobileNavigation}
          buttonRef={navigationButtonRef} onToggle={onToggleNavigation} />)}
      <section className="relative flex-1 min-w-0 min-h-0 overflow-hidden">
        {overview && (
          <ProjectOverview project={project} />
        )}
        {view.kind === 'analytics' && <AnalyticsPage />}
        {activeTask && <TaskView key={`${activeTask.id}:${view.kind === 'task' ? view.panel ?? 'default' : 'default'}`} task={activeTask}
          initialPanel={view.kind === 'task' ? view.panel : undefined} />}
      </section>
      <div className="shrink-0 px-8 pb-8 max-[980px]:px-[22px] max-[700px]:px-3 max-[700px]:pb-2">
        <WorkspaceUsageLimits />
      </div>
    </main>
  )
}

/*
 * On macOS the traffic lights normally sit over the sidebar's brand row. With
 * the sidebar collapsed they land here instead, so a slim strip takes over as
 * the window's drag handle and keeps the gutter clear.
 */
function NavigationHeader({ scale, expanded, mobileNavigation, buttonRef, onToggle }: {
  scale: number
  expanded: boolean
  mobileNavigation: boolean
  buttonRef: RefObject<HTMLButtonElement | null>
  onToggle: () => void
}): JSX.Element {
  return (
    <div
      style={IS_MAC ? { height: 44 / scale, paddingLeft: 78 / scale } : undefined}
      className={cn('flex shrink-0 items-center gap-3 h-11 px-4 text-[11px] font-semibold tracking-[0.12em] text-dim', IS_MAC && 'drag-region')}
    >
      ANVIL
      <button
        ref={buttonRef}
        className="no-drag grid size-8 shrink-0 place-items-center text-dim hover:text-fg hover:bg-hover focus-visible:outline focus-visible:outline-accent"
        aria-label={mobileNavigation ? 'Open navigation' : 'Expand sidebar'}
        title={mobileNavigation ? 'Open navigation' : 'Expand sidebar'}
        aria-controls="task-sidebar"
        aria-expanded={expanded}
        onClick={onToggle}
      >
        <Icon icon="arrow-right-to-line" size={18} aria-hidden="true" />
      </button>
    </div>
  )
}
