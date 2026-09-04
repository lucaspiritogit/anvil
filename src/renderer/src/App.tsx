import type { JSX } from 'react'
import { useEffect } from 'react'
import { Sidebar } from './components/Sidebar'
import { Workspace } from './components/Workspace'
import { NewTaskModal } from './components/NewTaskModal'
import { SettingsModal } from './components/SettingsModal'
import { useStore } from './state/store'

export function App(): JSX.Element {
  const ready = useStore((s) => s.ready)
  const load = useStore((s) => s.load)
  const applyEvent = useStore((s) => s.applyEvent)
  const applyRunUpdate = useStore((s) => s.applyRunUpdate)
  const newTaskOpen = useStore((s) => s.newTaskOpen)
  const settingsOpen = useStore((s) => s.settingsOpen)

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    const offEvent = window.anvil.runs.onEvent(applyEvent)
    const offUpdate = window.anvil.runs.onUpdated(applyRunUpdate)
    return () => {
      offEvent()
      offUpdate()
    }
  }, [applyEvent, applyRunUpdate])

  if (!ready) {
    return <div className="boot">Loading…</div>
  }

  return (
    <div className="app">
      <Sidebar />
      <Workspace />
      {newTaskOpen && <NewTaskModal />}
      {settingsOpen && <SettingsModal />}
    </div>
  )
}
