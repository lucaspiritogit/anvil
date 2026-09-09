import type { JSX } from 'react'
import { useEffect, useLayoutEffect, useRef } from 'react'
import { ProjectTerminal } from './components/ProjectTerminal'
import { Sidebar } from './components/Sidebar'
import { Workspace } from './components/Workspace'
import { SettingsPage } from './components/SettingsPage'
import { DEFAULT_FONT_SIZE, normalizeFontSize } from '@shared/appearance'
import { TaskContextMenu } from './components/TaskContextMenu'
import { matchesAccelerator } from './keys'
import { cn } from './ui'
import { useStore } from './state/store'
import { DEFAULT_KEYBINDINGS, SHORTCUTS } from '@shared/keybindings'
import type { ShortcutId } from '@shared/keybindings'

export function App(): JSX.Element {
  const workspaceRef = useRef<HTMLDivElement>(null)
  const suspendedDialogs = useRef<HTMLDialogElement[]>([])
  const fontSize = useStore((s) => s.settings?.fontSize)
  const setSettingsOpen = useStore((s) => s.setSettingsOpen)
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

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    const scale = normalizeFontSize(fontSize) / DEFAULT_FONT_SIZE
    const root = document.getElementById('root')!
    root.style.zoom = String(scale)
    root.style.height = '100%'
  }, [fontSize])

  useEffect(() => {
    const offOpen = window.anvil.settings.onOpenRequested(() => setSettingsOpen(true))
    const offSettings = window.anvil.settings.onChanged((settings) => useStore.setState({ settings }))
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
    return () => { offOpen(); offSettings(); offProjects() }
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

  // Capture fields stop propagation so recording a shortcut never invokes it.
  useEffect(() => {
    const actions: Record<ShortcutId, () => void> = { toggleSidebar, focusTaskComposer }
    const onKey = (event: KeyboardEvent): void => {
      // Auto-repeat fires while a chord is held down; a shortcut is an action
      // per press, so only the first event of a hold counts.
      if (event.repeat) return
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
  }, [keybindings, toggleSidebar, focusTaskComposer, settingsOpen, setSettingsOpen])

  useEffect(() => {
    const offEvent = window.anvil.tasks.onEvent(applyEvent)
    const offUpdate = window.anvil.tasks.onUpdated(applyTaskUpdate)
    return () => {
      offEvent()
      offUpdate()
    }
  }, [applyEvent, applyTaskUpdate])

  if (!ready) {
    return <div className="grid place-items-center h-full text-dim">Loading…</div>
  }

  // Collapsing closes the grid column while the sidebar slides out behind it,
  // so the workspace grows in step with the panel leaving.
  return (
    <>
      <div
        className={cn(
          'grid h-full min-h-0 grid-rows-[minmax(0,1fr)] overflow-hidden transition-[grid-template-columns] duration-[180ms] ease-[ease] motion-reduce:transition-none',
          settingsOpen
            ? 'grid-cols-[304px_1fr] max-[700px]:grid-cols-1 max-[700px]:grid-rows-[auto_minmax(0,1fr)]'
            : sidebarCollapsed ? 'grid-cols-[0_1fr]' : 'grid-cols-[304px_1fr]'
        )}
      >
        <Sidebar />
        <div ref={workspaceRef} className={cn('min-w-0 min-h-0', settingsOpen && 'hidden')} inert={settingsOpen}>
          <Workspace />
          {taskMenu && <TaskContextMenu key={`${taskMenu.taskId}:${taskMenu.x}:${taskMenu.y}`} />}
        </div>
        {settingsOpen && <SettingsPage />}
      </div>
      <ProjectTerminal />
    </>
  )
}
