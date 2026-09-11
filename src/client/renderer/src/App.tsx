import { TerminalDrawer } from './components/TerminalDrawer'
import type { JSX } from 'react'
import { lazy, Suspense, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { AppSkeleton } from './components/AppSkeleton'
import { OverviewBackground } from './components/OverviewBackground'
import { Sidebar } from './components/Sidebar'
import { Workspace } from './components/Workspace'
import { DEFAULT_FONT_SIZE, normalizeFontSize } from '@shared/appearance'
import { TaskContextMenu } from './components/TaskContextMenu'
import { matchesAccelerator, isTerminalShortcut } from './keys'
import { cn } from './ui'
import { useStore } from './state/store'
import { DEFAULT_KEYBINDINGS, SHORTCUTS } from '@shared/keybindings'
import type { ShortcutId } from '@shared/keybindings'

const SettingsPage = lazy(async () => {
  const { SettingsPage } = await import('./components/SettingsPage')
  return { default: SettingsPage }
})

export function App(): JSX.Element {
  const [terminalOpen, setTerminalOpen] = useState(false)
  const [terminalCreated, setTerminalCreated] = useState(false)
  const projectId = useStore((s) => s.activeProjectId ?? s.projects[0]?.id)
  const workspaceRef = useRef<HTMLDivElement>(null)
  const suspendedDialogs = useRef<HTMLDialogElement[]>([])
  const fontSize = useStore((s) => s.settings?.fontSize)
  const setSettingsOpen = useStore((s) => s.setSettingsOpen)
  const workspaceId = useStore((s) => s.activeWorkspaceId)
  useEffect(() => { setTerminalOpen(false); setTerminalCreated(false) }, [workspaceId])
  const switching = useStore((s) => s.workspaceSwitching)
  const workspaceError = useStore((s) => s.workspaceError)
  const ready = useStore((s) => s.ready)
  const load = useStore((s) => s.load)
  const applyEvent = useStore((s) => s.applyEvent)
  const applyTaskUpdate = useStore((s) => s.applyTaskUpdate)
  const settingsOpen = useStore((s) => s.settingsOpen)
  const taskMenu = useStore((s) => s.taskMenu)
  const sidebarCollapsed = useStore((s) => s.sidebarCollapsed)
  const toggleSidebar = useStore((s) => s.toggleSidebar)
  const focusTaskComposer = useStore((s) => s.focusTaskComposer)
  const keybindings = useStore((s) => s.settings?.keybindings) ?? DEFAULT_KEYBINDINGS

  // Wait for the HTTP client and event stream before loading domain state.
  useEffect(() => {
    const offReady = window.anvil.app.onReady(() => { void load() })
    const offInitFailed = window.anvil.app.onInitFailed((message) => useStore.setState({ workspaceError: message }))
    return () => {
      offReady()
      offInitFailed()
    }
  }, [load])

  useEffect(() => {
    const scale = normalizeFontSize(fontSize) / DEFAULT_FONT_SIZE
    const root = document.getElementById('root')!
    root.style.zoom = String(scale)
    root.style.height = '100%'
  }, [fontSize])

  useEffect(() => {
    const offOpen = window.anvil.settings.onOpenRequested(() => setSettingsOpen(true))
    const offModels = window.anvil.agents.onModelsChanged(useStore.getState().invalidateAgentModels)
    const offSettings = window.anvil.settings.onChanged(useStore.getState().applySettingsChange)
    const offSelected = window.anvil.workspaces.onSelected(useStore.getState().receiveWorkspaceSelection)
    const offWorkspaces = window.anvil.workspaces.onChanged((workspaces) => useStore.setState({ workspaces }))
    const offProjects = window.anvil.projects.onChanged((projects) => {
      useStore.setState((state) => {
        const tasks = state.tasks.filter((task) => projects.some((project) => project.id === task.projectId))
        const view = state.view
        return {
          projects,
          tasks,
          activeProjectId: projects.some((project) => project.id === state.activeProjectId) ? state.activeProjectId : projects[0]?.id ?? null,
          view: view.kind === 'task' && !tasks.some((task) => task.id === view.taskId) ? { kind: 'home' } : view
        }
      })
    })
    return () => {
      offOpen()
      offSettings()
      offModels()
      offWorkspaces()
      offSelected()
      offProjects()
    }
  }, [setSettingsOpen])

  // Native dialogs occupy the browser's top layer even inside a hidden workspace.
  // Suspend them during settings and restore their mounted forms on return.
  useLayoutEffect(() => {
    if (settingsOpen) {
      suspendedDialogs.current = [...(workspaceRef.current?.querySelectorAll<HTMLDialogElement>('dialog:modal') ?? [])]
      for (const dialog of suspendedDialogs.current) dialog.close()
    } else {
      for (const dialog of suspendedDialogs.current) {
        if (dialog.isConnected && !dialog.open) dialog.showModal()
      }
      suspendedDialogs.current = []
    }
  }, [settingsOpen, ready])

  useLayoutEffect(() => {
    if (sidebarCollapsed && document.activeElement?.closest('[aria-label="Task sidebar"]')) {
      workspaceRef.current?.focus()
    }
  }, [sidebarCollapsed])

  // Capture fields stop propagation so recording a shortcut never invokes it.
  useEffect(() => {
    const actions: Record<ShortcutId, () => void> = { toggleSidebar, focusTaskComposer }
    const onKey = (event: KeyboardEvent): void => {
      // Auto-repeat fires while a chord is held down; a shortcut is an action
      // per press, so only the first event of a hold counts.
      if (event.repeat || useStore.getState().workspaceSwitching) return
      if (isTerminalShortcut(event)) {
        event.preventDefault()
        if (projectId) {
          setSettingsOpen(false)
          setTerminalCreated(true)
          setTerminalOpen((open) => !open)
        }
        return
      }
      if ((event.target as HTMLElement)?.closest('[data-terminal]')) return
      if (event.key === 'Escape' && useStore.getState().settingsOpen) {
        event.preventDefault()
        setSettingsOpen(false)
        return
      }
      if (matchesAccelerator(event, 'Mod+,')) {
        event.preventDefault()
        if (!settingsOpen) setSettingsOpen(true)
        return
      }
      if (settingsOpen) return
      for (const shortcut of SHORTCUTS) {
        if (!matchesAccelerator(event, keybindings[shortcut.id])) continue
        event.preventDefault()
        actions[shortcut.id]()
        return
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [keybindings, toggleSidebar, focusTaskComposer, settingsOpen, setSettingsOpen, projectId])

  useEffect(() => {
    const offEvent = window.anvil.tasks.onEvent(applyEvent)
    const offUpdate = window.anvil.tasks.onUpdated(applyTaskUpdate)
    return () => {
      offEvent()
      offUpdate()
    }
  }, [applyEvent, applyTaskUpdate])

  if (!ready) {
    if (!workspaceError) return <AppSkeleton />
    return <div className="grid place-items-center h-full text-dim"><p role="alert">{workspaceError}</p><button onClick={() => void load()}>Retry</button></div>
  }

  // Collapsing closes the grid column while the sidebar slides out behind it,
  // so the workspace grows in step with the panel leaving.
  return (
    <>
      <div
        className={cn(
          'relative isolate grid h-full min-h-0 grid-rows-[minmax(0,1fr)] overflow-hidden transition-[grid-template-columns] duration-[180ms] ease-[ease] motion-reduce:transition-none',
          settingsOpen
            ? 'grid-cols-[304px_1fr] max-[700px]:grid-cols-1 max-[700px]:grid-rows-[auto_minmax(0,1fr)]'
            : sidebarCollapsed ? 'grid-cols-[0_1fr]' : 'grid-cols-[304px_1fr]'
        )}
      >
        <OverviewBackground />
        <div className="contents" inert={switching}><Sidebar /></div>
        <div ref={workspaceRef} tabIndex={-1} className={cn('flex flex-col min-w-0 min-h-0 outline-none', settingsOpen && 'hidden')} inert={settingsOpen || switching}>
          <div className="min-h-0 flex-1"><Workspace key={workspaceId} /></div>
          {terminalCreated && projectId && <TerminalDrawer key={`${workspaceId}:${projectId}`} projectId={projectId} visible={terminalOpen} onClose={() => { setTerminalCreated(false); setTerminalOpen(false) }} />}
          {taskMenu && <TaskContextMenu key={`${taskMenu.taskId}:${taskMenu.x}:${taskMenu.y}`} />}
        </div>
        {settingsOpen && <div className="contents" inert={switching}><Suspense fallback={<p role="status" className="p-5 text-sm text-dim">Loading settings…</p>}><SettingsPage key={workspaceId} /></Suspense></div>}
      </div>
      {switching && <div role="status" className="fixed bottom-4 right-4 z-50 border border-line bg-canvas p-3 text-sm shadow-lg">Switching workspace…</div>}
      {workspaceError && <div role="alert" className="fixed bottom-4 right-4 z-50 rounded border border-line bg-canvas p-3 text-sm shadow-lg">
        <p>{workspaceError}</p>
        <button className="mt-2 text-accent" onClick={() => { if (workspaceId) void useStore.getState().selectWorkspace(workspaceId) }}>Retry workspace</button>
      </div>}
    </>
  )
}
