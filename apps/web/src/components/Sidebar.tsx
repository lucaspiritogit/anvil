import type { JSX, RefObject } from 'react'
import { useEffect, useMemo, useState } from 'react'
import { Icon } from '../icons'
import { SETTINGS_SECTIONS } from '../settings-sections'
import { useStore } from '../state/store'
import { cn } from '../ui'
import { taskNeedsReview } from '@anvil/protocol/task-review'
import { useSidebarIssueSnapshots } from '../hooks/use-task-issues'
import { SidebarTaskList } from './SidebarTaskList'
import { WorkspacePicker } from './WorkspacePicker'
import { CaffeineToggle } from './CaffeineToggle'
import { sidebarTaskProjects } from './sidebar-task-projects'
import { AnvilBrand, WindowTitlebar } from './WindowTitlebar'

const ICON_BUTTON = 'grid size-8 shrink-0 place-items-center text-dim hover:text-fg hover:bg-hover focus-visible:outline focus-visible:outline-accent'
const COLLAPSED_PROJECTS_STORAGE_KEY = 'anvil-sidebar-collapsed-projects'

function loadCollapsedProjects(): Record<string, string[]> {
  try {
    const stored: unknown = JSON.parse(window.localStorage.getItem(COLLAPSED_PROJECTS_STORAGE_KEY) ?? '{}')
    if (typeof stored !== 'object' || stored === null || Array.isArray(stored)) return {}
    return Object.fromEntries(Object.entries(stored).filter((entry): entry is [string, string[]] =>
      Array.isArray(entry[1]) && entry[1].every((projectId: unknown) => typeof projectId === 'string')))
  } catch {
    return {}
  }
}

export function Sidebar({ onOpenTerminal, terminalAvailable, mobileNavigation, mobileNavigationOpen,
  mobileNavigationCloseRef, onCloseMobileNavigation, onNavigate }: {
  onOpenTerminal: () => void
  terminalAvailable: boolean
  mobileNavigation: boolean
  mobileNavigationOpen: boolean
  mobileNavigationCloseRef: RefObject<HTMLButtonElement | null>
  onCloseMobileNavigation: () => void
  onNavigate: () => void
}): JSX.Element {
  const workspaceId = useStore((state) => state.activeWorkspaceId)
  const projects = useStore((state) => state.projects)
  const tasks = useStore((state) => state.tasks)
  const taskSeenAt = useStore((state) => state.taskSeenAt)
  const activeProjectId = useStore((state) => state.activeProjectId)
  const selectProject = useStore((state) => state.selectProject)
  const view = useStore((state) => state.view)
  const settingsOpen = useStore((state) => state.settingsOpen)
  const settingsSection = useStore((state) => state.settingsSection)
  const setSettingsSection = useStore((state) => state.setSettingsSection)
  const setSettingsOpen = useStore((state) => state.setSettingsOpen)
  const showAnalytics = useStore((state) => state.showAnalytics)
  const focusTaskComposer = useStore((state) => state.focusTaskComposer)
  const sidebarCollapsed = useStore((state) => state.sidebarCollapsed)
  const toggleSidebar = useStore((state) => state.toggleSidebar)
  const [search, setSearch] = useState('')
  const [collapsedProjectsByWorkspace, setCollapsedProjectsByWorkspace] = useState(loadCollapsedProjects)
  const [expandedSettledGroups, setExpandedSettledGroups] = useState<Set<string>>(() => new Set())
  const [now, setNow] = useState(Date.now())

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000)
    return () => window.clearInterval(timer)
  }, [])

  useEffect(() => {
    setSearch('')
    setExpandedSettledGroups(new Set())
  }, [workspaceId])

  useEffect(() => {
    try {
      window.localStorage.setItem(COLLAPSED_PROJECTS_STORAGE_KEY, JSON.stringify(collapsedProjectsByWorkspace))
    } catch {}
  }, [collapsedProjectsByWorkspace])

  const collapsedProjects = useMemo(() => new Set(workspaceId ? collapsedProjectsByWorkspace[workspaceId] ?? [] : []),
    [workspaceId, collapsedProjectsByWorkspace])
  const query = search.trim().toLowerCase()
  const snapshots = useSidebarIssueSnapshots(Boolean(query))
  const entries = useMemo(() => sidebarTaskProjects({
    workspaceId, projects, tasks, query, snapshots, taskSeenAt, collapsedProjects, expandedSettledGroups
  }), [workspaceId, projects, tasks, query, snapshots, taskSeenAt, collapsedProjects, expandedSettledGroups])
  const reviewCount = useMemo(() => tasks.filter((task) => taskNeedsReview(task, taskSeenAt[task.id])).length,
    [tasks, taskSeenAt])
  const listKey = JSON.stringify([workspaceId, search])
  const sidebarHidden = mobileNavigation ? !mobileNavigationOpen : sidebarCollapsed
  const toggleProject = (projectId: string, expanded: boolean): void => {
    if (!workspaceId) return
    if (query) setSearch('')
    setCollapsedProjectsByWorkspace((previous) => {
      const collapsed = new Set(previous[workspaceId] ?? [])
      if (expanded) collapsed.add(projectId)
      else collapsed.delete(projectId)
      return { ...previous, [workspaceId]: [...collapsed] }
    })
  }
  const toggleSettled = (groupId: string, expanded: boolean): void => {
    if (query) setSearch('')
    setExpandedSettledGroups((previous) => {
      const next = new Set(previous)
      if (expanded) next.delete(groupId)
      else next.add(groupId)
      return next
    })
  }

  if (settingsOpen) return (
    <aside aria-label="Sidebar" className="flex min-h-0 flex-col border-r border-line bg-canvas max-[700px]:border-b max-[700px]:border-r-0">
      <WindowTitlebar>
        <h1 className="font-mono text-sm font-semibold">Settings</h1>
      </WindowTitlebar>
      <nav aria-label="Settings sections" className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto p-3 max-[700px]:flex-row max-[700px]:overflow-x-auto">
        {SETTINGS_SECTIONS.map((section) => (
          <button key={section.id} aria-current={settingsSection === section.id ? 'page' : undefined}
            className={cn('flex shrink-0 items-center gap-2.5 px-3 py-2.5 text-left text-[13px] whitespace-nowrap focus-visible:outline focus-visible:outline-accent', settingsSection === section.id ? 'row-selected text-fg' : 'text-dim hover:bg-hover hover:text-fg')}
            onClick={() => setSettingsSection(section.id)}>
            <Icon icon={section.icon} size={18} aria-hidden="true" />
            {section.label}
          </button>
        ))}
      </nav>
      <button className="mx-3 mb-3 flex shrink-0 items-center gap-2 px-3 py-2 text-left text-xs text-dim hover:bg-hover hover:text-fg focus-visible:outline focus-visible:outline-accent"
        onClick={() => setSettingsOpen(false)}>
        <Icon icon="x" size={16} aria-hidden="true" />
        Back to workspace
      </button>
    </aside>
  )

  return (
    <aside
      id="task-sidebar"
      aria-label="Task sidebar"
      className={cn(
        'flex flex-col w-[304px] min-h-0 bg-canvas border-r border-line',
        'max-[700px]:fixed max-[700px]:inset-y-0 max-[700px]:left-0 max-[700px]:z-30 max-[700px]:max-w-[calc(100vw-48px)] max-[700px]:shadow-2xl',
        'transition-transform duration-[180ms] ease-[ease] motion-reduce:transition-none',
        sidebarHidden && '-translate-x-full'
      )}
      inert={sidebarHidden}
      aria-hidden={sidebarHidden || undefined}
    >
      <WindowTitlebar>
        <AnvilBrand />
        {reviewCount > 0 && (
          <span
            role="status"
            aria-label={`${reviewCount} ${reviewCount === 1 ? 'task' : 'tasks'} ready for review`}
            title={`${reviewCount} ${reviewCount === 1 ? 'task' : 'tasks'} ready for review`}
            className="ml-2 inline-flex h-[18px] items-center gap-1 bg-review px-1.5 font-mono text-[10px] font-semibold text-canvas"
          >
            <span aria-hidden="true">◆</span>
            {reviewCount}
          </span>
        )}
        <button
          ref={mobileNavigation ? mobileNavigationCloseRef : undefined}
          className={cn(ICON_BUTTON, 'no-drag ml-auto')}
          aria-label={mobileNavigation ? 'Close navigation' : 'Collapse sidebar'}
          title={mobileNavigation ? 'Close navigation' : 'Collapse sidebar'}
          aria-controls="task-sidebar"
          aria-expanded={true}
          onClick={mobileNavigation ? onCloseMobileNavigation : toggleSidebar}
        >
          <Icon icon={mobileNavigation ? 'x' : 'arrow-left-to-line'} size={18} aria-hidden="true" />
        </button>
      </WindowTitlebar>

      <div className="flex shrink-0 flex-col gap-2 px-2.5 pb-3">
        <button
          className="flex h-9 shrink-0 items-center gap-2 bg-accent px-2.5 text-xs font-semibold text-canvas enabled:hover:brightness-110 disabled:bg-overlay disabled:text-faint focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          aria-label="New task"
          title="New task"
          disabled={!workspaceId}
          onClick={() => { focusTaskComposer(); if (mobileNavigation) onNavigate() }}
        >
          <Icon icon="pencil" size={16} aria-hidden="true" />
          New Task
        </button>
        <button
          className="flex h-9 shrink-0 items-center gap-2 border border-line-strong bg-overlay px-2.5 text-xs text-fg enabled:hover:bg-hover disabled:text-faint focus-visible:outline focus-visible:outline-accent"
          aria-label="Open terminal"
          title="Open terminal"
          disabled={!terminalAvailable}
          onClick={onOpenTerminal}
        >
          <Icon icon="terminal" size={16} aria-hidden="true" />
          Terminal
        </button>
        <div className="flex items-center gap-2 h-9 px-2.5 border border-line-strong bg-void focus-within:border-accent">
          <Icon icon="search" size={16} className="shrink-0 text-dim" aria-hidden="true" />
          <input
            type="search"
            aria-label="Search tasks"
            placeholder="Search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            className="w-full min-w-0 bg-transparent text-xs text-fg placeholder:text-faint outline-none [&::-webkit-search-cancel-button]:appearance-none"
          />
          {search && (
            <button className="text-dim hover:text-fg" aria-label="Clear search" onClick={() => setSearch('')}>
              <Icon icon="x" size={14} aria-hidden="true" />
            </button>
          )}
        </div>
      </div>

      <nav aria-label="Projects and tasks" className="flex flex-1 min-h-0 flex-col border-t border-line pt-1 pb-2">
        <SidebarTaskList key={listKey} entries={entries} snapshots={snapshots} now={now} view={view}
          activeProjectId={activeProjectId} onToggleProject={toggleProject} onToggleSettled={toggleSettled}
          onSelectProject={(projectId) => { selectProject(projectId); if (mobileNavigation) onNavigate() }}
          onNavigate={mobileNavigation ? onNavigate : undefined} />
      </nav>

      <CaffeineToggle />

      <div className="mx-2.5 mt-2 mb-2 flex shrink-0 gap-1 border-t border-line pt-2">
        <button
          aria-current={view.kind === 'analytics' ? 'page' : undefined}
          className={cn('flex h-8 min-w-0 flex-1 items-center gap-2 px-2 text-left text-xs hover:bg-hover focus-visible:outline focus-visible:outline-accent',
            view.kind === 'analytics' ? 'row-selected text-fg' : 'text-dim hover:text-fg')}
          onClick={() => { showAnalytics(); if (mobileNavigation) onNavigate() }}
        >
          <Icon icon="chart-no-axes-combined" size={16} className="shrink-0" aria-hidden="true" />
          <span className="truncate">Analytics</span>
        </button>
        <button
          className="flex h-8 min-w-0 flex-1 items-center gap-2 px-2 text-left text-xs text-dim hover:bg-hover hover:text-fg focus-visible:outline focus-visible:outline-accent"
          onClick={() => { if (mobileNavigation) onNavigate(); setSettingsOpen(true) }}
        >
          <Icon icon="settings" size={16} className="shrink-0" aria-hidden="true" />
          <span className="truncate">Settings</span>
        </button>
      </div>
      <div className="shrink-0 px-2.5 pb-3">
        <WorkspacePicker />
      </div>
    </aside>
  )
}
