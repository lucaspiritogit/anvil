import type { JSX } from 'react'
import { useEffect } from 'react'
import { Sidebar } from './components/Sidebar'
import { Workspace } from './components/Workspace'
import { NewTaskModal } from './components/NewTaskModal'
import { SettingsModal } from './components/SettingsModal'
import { TaskContextMenu } from './components/TaskContextMenu'
import { matchesAccelerator } from './keys'
import { cn } from './ui'
import { useStore } from './state/store'
import { DEFAULT_KEYBINDINGS, SHORTCUTS } from '@shared/keybindings'
import type { ShortcutId } from '@shared/keybindings'

export function App(): JSX.Element {
  const ready = useStore((s) => s.ready)
  const load = useStore((s) => s.load)
  const applyEvent = useStore((s) => s.applyEvent)
  const applyTaskUpdate = useStore((s) => s.applyTaskUpdate)
  const newTaskOpen = useStore((s) => s.newTaskOpen)
  const settingsOpen = useStore((s) => s.settingsOpen)
  const taskMenu = useStore((s) => s.taskMenu)
  const sidebarCollapsed = useStore((s) => s.sidebarCollapsed)
  const toggleSidebar = useStore((s) => s.toggleSidebar)
  const focusTaskComposer = useStore((s) => s.focusTaskComposer)
  const keybindings = useStore((s) => s.settings?.keybindings) ?? DEFAULT_KEYBINDINGS

  useEffect(() => {
    void load()
  }, [load])

  // One listener drives every shortcut, so a new binding is an entry here plus
  // one in SHORTCUTS. The settings capture field stops propagation while it is
  // recording, which is what keeps a chord from firing as it is being bound.
  useEffect(() => {
    const actions: Record<ShortcutId, () => void> = { toggleSidebar, focusTaskComposer }
    const onKey = (event: KeyboardEvent): void => {
      // Auto-repeat fires while a chord is held down; a shortcut is an action
      // per press, so only the first event of a hold counts.
      if (event.repeat) return
      for (const shortcut of SHORTCUTS) {
        if (!matchesAccelerator(event, keybindings[shortcut.id])) continue
        event.preventDefault()
        actions[shortcut.id]()
        return
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [keybindings, toggleSidebar, focusTaskComposer])

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
    <div
      className={cn(
        'grid h-full min-h-0 grid-rows-[minmax(0,1fr)] overflow-hidden transition-[grid-template-columns] duration-[180ms] ease-[ease] motion-reduce:transition-none',
        sidebarCollapsed ? 'grid-cols-[0_1fr]' : 'grid-cols-[304px_1fr]'
      )}
    >
      <Sidebar />
      <Workspace />
      {newTaskOpen && <NewTaskModal />}
      {settingsOpen && <SettingsModal />}
      {taskMenu && <TaskContextMenu key={`${taskMenu.taskId}:${taskMenu.x}:${taskMenu.y}`} />}
    </div>
  )
}
