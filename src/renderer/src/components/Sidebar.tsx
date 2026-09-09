import type { JSX } from 'react'
import { useEffect, useMemo, useState } from 'react'
import { HugeiconsIcon } from '@hugeicons/react'
import {
  ArrowDown01Icon, Cancel01Icon, Edit02Icon,
  FolderAddIcon, Search01Icon, Settings01Icon
} from '@hugeicons/core-free-icons'
import { SETTINGS_SECTIONS } from '../settings-sections'
import { IS_MAC } from '../keys'
import { useStore } from '../state/store'
import { cn } from '../ui'
import { useSidebarIssueSnapshots } from '../hooks/use-task-issues'
import { SidebarTask } from './SidebarTask'
import { ProjectPicker } from './ProjectPicker'

const ICON_BUTTON = 'grid size-8 shrink-0 place-items-center text-dim hover:text-fg hover:bg-hover focus-visible:outline focus-visible:outline-accent'

export function Sidebar(): JSX.Element {
  const projects = useStore((state) => state.projects)
  const tasks = useStore((state) => state.tasks)
  const activeProjectId = useStore((state) => state.activeProjectId)
  const view = useStore((state) => state.view)
  const selectProject = useStore((state) => state.selectProject)
  const addProject = useStore((state) => state.addProject)
  const settingsOpen = useStore((state) => state.settingsOpen)
  const settingsSection = useStore((state) => state.settingsSection)
  const setSettingsSection = useStore((state) => state.setSettingsSection)
  const setSettingsOpen = useStore((state) => state.setSettingsOpen)
  const setNewTaskOpen = useStore((state) => state.setNewTaskOpen)
  const sidebarCollapsed = useStore((state) => state.sidebarCollapsed)
  const [projectFilter, setProjectFilter] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [settledOpen, setSettledOpen] = useState(false)
  const [now, setNow] = useState(Date.now())

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000)
    return () => window.clearInterval(timer)
  }, [])

  useEffect(() => {
    if (projectFilter && !projects.some((project) => project.id === projectFilter)) setProjectFilter(null)
  }, [projectFilter, projects])

  const projectById = useMemo(() => new Map(projects.map((project) => [project.id, project])), [projects])
  const snapshots = useSidebarIssueSnapshots()
  const query = search.trim().toLowerCase()
  const matching = tasks.filter((task) => {
    if (projectFilter && task.projectId !== projectFilter) return false
    return !query || [task.title, task.branchName, projectById.get(task.projectId)?.name,
      ...(snapshots.get(task.id)?.children.map((issue) => issue.title) ?? [])]
      .some((text) => text?.toLowerCase().includes(query))
  })
  const activeTasks = matching.filter((task) => task.settledAt === undefined)
  const settledTasks = matching.filter((task) => task.settledAt !== undefined)
    .sort((first, second) => second.settledAt! - first.settledAt!)
  const showSettled = settledOpen || Boolean(query)

  if (settingsOpen) return (
    <aside aria-label="Sidebar" className="flex min-h-0 flex-col border-r border-line bg-canvas max-[700px]:border-b max-[700px]:border-r-0">
      <header className={cn('drag-region flex h-11 shrink-0 items-center px-4', IS_MAC && 'pl-[78px]')}>
        <h1 className="text-sm font-semibold">Settings</h1>
      </header>
      <nav aria-label="Settings sections" className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto p-3 max-[700px]:flex-row max-[700px]:overflow-x-auto">
        {SETTINGS_SECTIONS.map((section) => (
          <button key={section.id} aria-current={settingsSection === section.id ? 'page' : undefined}
            className={cn('flex shrink-0 items-center gap-2.5 rounded-md px-3 py-2.5 text-left text-[13px] whitespace-nowrap focus-visible:outline focus-visible:outline-accent', settingsSection === section.id ? 'bg-accent/10 text-accent' : 'text-dim hover:bg-hover hover:text-fg')}
            onClick={() => setSettingsSection(section.id)}>
            <HugeiconsIcon icon={section.icon} size={18} aria-hidden="true" />
            {section.label}
          </button>
        ))}
      </nav>
      <button className="mx-3 mb-3 flex shrink-0 items-center gap-2 px-3 py-2 text-left text-xs text-dim hover:bg-hover hover:text-fg focus-visible:outline focus-visible:outline-accent"
        onClick={() => setSettingsOpen(false)}>
        <HugeiconsIcon icon={Cancel01Icon} size={16} aria-hidden="true" />
        Back to workspace
      </button>
    </aside>
  )

  return (
    <aside
      aria-label="Task sidebar"
      className={cn(
        'flex flex-col w-[304px] min-h-0 bg-canvas border-r border-line',
        'transition-transform duration-[180ms] ease-[ease] motion-reduce:transition-none',
        sidebarCollapsed && '-translate-x-full'
      )}
      inert={sidebarCollapsed}
    >
      <div className={cn('flex shrink-0 items-center h-11 px-4 text-[11px] font-semibold tracking-[0.12em] text-dim', IS_MAC && 'drag-region pl-[78px]')}>
        ANVIL
      </div>

      <div className="flex shrink-0 items-center gap-1.5 px-2.5 pb-3">
        <div className="flex min-w-0 flex-1 items-center gap-2 h-9 px-2.5 border border-line focus-within:border-dim/60">
          <HugeiconsIcon icon={Search01Icon} size={16} className="shrink-0 text-dim" aria-hidden="true" />
          <input
            type="search"
            aria-label="Search tasks"
            placeholder="Search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            className="w-full min-w-0 bg-transparent text-xs text-fg placeholder:text-dim outline-none [&::-webkit-search-cancel-button]:appearance-none"
          />
          {search && (
            <button className="text-dim hover:text-fg" aria-label="Clear search" onClick={() => setSearch('')}>
              <HugeiconsIcon icon={Cancel01Icon} size={14} aria-hidden="true" />
            </button>
          )}
        </div>
        <button
          className={cn(ICON_BUTTON, 'size-9 border border-line disabled:opacity-40')}
          aria-label="New task"
          title="New task"
          disabled={!activeProjectId}
          onClick={() => setNewTaskOpen(true)}
        >
          <HugeiconsIcon icon={Edit02Icon} size={18} aria-hidden="true" />
        </button>
      </div>

      <div className="flex shrink-0 items-end gap-1.5 px-2.5 pb-3">
        <ProjectPicker
          key={JSON.stringify(projects.map((project) => project.id))}
          projects={projects}
          value={projectFilter}
          onChange={(id) => { setProjectFilter(id); if (id) selectProject(id) }}
        />
        <button className={ICON_BUTTON} aria-label="Add project" title="Add project" onClick={() => void addProject().then(() => {
          const nextProjectId = useStore.getState().activeProjectId
          if (nextProjectId !== activeProjectId) setProjectFilter(nextProjectId)
        })}>
          <HugeiconsIcon icon={FolderAddIcon} size={18} aria-hidden="true" />
        </button>
      </div>

      <nav aria-label="Active tasks" className="flex-1 min-h-0 space-y-1.5 px-2.5 pb-2 overflow-y-auto overscroll-contain">
        <ul className="space-y-1.5">
          {activeTasks.map((task) => (
            <SidebarTask key={task.id} snapshot={snapshots.get(task.id)} task={task} project={projectById.get(task.projectId)} now={now} active={view.kind === 'task' && view.taskId === task.id} />
          ))}
        </ul>
        {!matching.length && <p className="px-2 py-4 text-xs text-dim">{query ? 'No matching tasks.' : 'No tasks yet.'}</p>}
        {!activeTasks.length && matching.length > 0 && <p className="px-2 py-4 text-xs text-dim">No active tasks.</p>}
      </nav>

      <section aria-label="Settled tasks" className="flex shrink-0 flex-col max-h-[35%] min-h-0 px-2.5">
        <button
          aria-expanded={showSettled}
          aria-controls="settled-task-list"
          onClick={() => { if (query) setSearch(''); setSettledOpen(!showSettled) }}
          className="flex shrink-0 w-full items-center gap-2 px-2 py-3 text-[11px] text-dim hover:text-fg"
        >
          <HugeiconsIcon icon={ArrowDown01Icon} size={13} className={cn('transition-transform', !showSettled && '-rotate-90')} aria-hidden="true" />
          <span>Settled</span>
          <span className="text-dim/60">{settledTasks.length}</span>
          <span className="h-px flex-1 bg-line" />
        </button>
        {showSettled && (
          <div id="settled-task-list" className="min-h-0 overflow-y-auto overscroll-contain pb-1">
            <ul className="space-y-1">
              {settledTasks.map((task) => (
                <SidebarTask key={task.id} snapshot={snapshots.get(task.id)} task={task} project={projectById.get(task.projectId)} now={now} compact active={view.kind === 'task' && view.taskId === task.id} />
              ))}
            </ul>
            {!settledTasks.length && <p className="px-2 pb-3 text-xs text-dim">No settled tasks.</p>}
          </div>
        )}
      </section>

      <button
        className="flex shrink-0 items-center gap-2.5 mx-2.5 my-2 px-2 py-2 text-left text-xs text-dim hover:bg-hover/60 hover:text-fg focus-visible:outline focus-visible:outline-accent"
        onClick={() => setSettingsOpen(true)}
      >
        <HugeiconsIcon icon={Settings01Icon} size={18} aria-hidden="true" />
        Settings
      </button>
    </aside>
  )
}
