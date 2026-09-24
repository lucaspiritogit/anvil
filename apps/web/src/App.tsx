import { RightSidePanel } from './components/RightSidePanel'
import type { JSX } from 'react'
import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { AppSkeleton } from './components/AppSkeleton'
import { OverviewBackground } from './components/OverviewBackground'
import { Sidebar } from './components/Sidebar'
import { Workspace } from './components/Workspace'
import { DEFAULT_FONT_SIZE, normalizeFontSize } from '@anvil/protocol/appearance'
import { TaskContextMenu } from './components/TaskContextMenu'
import { CommandPalette } from './components/CommandPalette'
import { matchesAccelerator, isTerminalShortcut } from './keys'
import { cn } from './ui'
import { useStore } from './state/store'
import { useComposerPreferences } from './state/composer-preferences'
import { DEFAULT_KEYBINDINGS, SHORTCUTS } from '@anvil/protocol/keybindings'
import type { ShortcutId } from '@anvil/protocol/keybindings'

const SettingsPage = lazy(async () => {
  const { SettingsPage } = await import('./components/SettingsPage')
  return { default: SettingsPage }
})

export function App(): JSX.Element {
  const [terminalOpen, setTerminalOpen] = useState(false)
  const [terminalCreated, setTerminalCreated] = useState(false)
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false)
  const [mobileNavigation, setMobileNavigation] = useState(() => window.matchMedia('(max-width: 700px)').matches)
  const [mobileNavigationOpen, setMobileNavigationOpen] = useState(false)
  const projectId = useStore((s) => s.activeProjectId ?? s.projects[0]?.id)
  const workspaceRef = useRef<HTMLDivElement>(null)
  const mobileNavigationButtonRef = useRef<HTMLButtonElement>(null)
  const mobileNavigationCloseRef = useRef<HTMLButtonElement>(null)
  const suspendedDialogs = useRef<HTMLDialogElement[]>([])
  const fontSize = useStore((s) => s.settings?.fontSize)
  const setSettingsOpen = useStore((s) => s.setSettingsOpen)
  const workspaceId = useStore((s) => s.activeWorkspaceId)
  useEffect(() => {
    setTerminalOpen(false)
    setTerminalCreated(false)
    setCommandPaletteOpen(false)
  }, [workspaceId])
  const switching = useStore((s) => s.workspaceSwitching)
  const workspaceError = useStore((s) => s.workspaceError)
  const ready = useStore((s) => s.ready)
  const load = useStore((s) => s.load)
  const applyEvent = useStore((s) => s.applyEvent)
  const applyTaskUpdate = useStore((s) => s.applyTaskUpdate)
  const applyTaskResultNoticeChange = useStore((s) => s.applyTaskResultNoticeChange)
  const settingsOpen = useStore((s) => s.settingsOpen)
  const taskMenu = useStore((s) => s.taskMenu)
  const sidebarCollapsed = useStore((s) => s.sidebarCollapsed)
  const toggleSidebar = useStore((s) => s.toggleSidebar)
  const focusTaskComposer = useStore((s) => s.focusTaskComposer)
  const cycleTaskComposerStyle = useStore((s) => s.cycleTaskComposerStyle)
  const keybindings = useStore((s) => s.settings?.keybindings) ?? DEFAULT_KEYBINDINGS

  useEffect(() => {
    if (settingsOpen || switching) setCommandPaletteOpen(false)
    if (settingsOpen) {
      setTerminalOpen(false)
      setTerminalCreated(false)
    }
  }, [settingsOpen, switching])

  const closeMobileNavigation = useCallback((returnFocus: boolean): void => {
    setMobileNavigationOpen(false)
    window.requestAnimationFrame(() => {
      if (returnFocus) mobileNavigationButtonRef.current?.focus()
      else workspaceRef.current?.focus()
    })
  }, [])

  const toggleNavigation = useCallback((): void => {
    if (!mobileNavigation) {
      toggleSidebar()
      return
    }
    if (mobileNavigationOpen) closeMobileNavigation(true)
    else setMobileNavigationOpen(true)
  }, [closeMobileNavigation, mobileNavigation, mobileNavigationOpen, toggleSidebar])

  const openTerminal = useCallback((): void => {
    if (!projectId) return
    setTerminalCreated(true)
    setTerminalOpen(true)
  }, [projectId])

  const cycleThinking = useCallback((): void => {
    const preferences = useComposerPreferences.getState()
    const agents = useStore.getState().agents
    const agentId = preferences.agentId || agents.find((agent) => agent.id === 'codex')?.id || agents[0]?.id || ''
    const model = preferences.modelsByAgent[agentId]?.trim() ?? ''
    const capabilities = useStore.getState().modelsByAgent[agentId]?.reasoningByModel?.[model]
    const options = capabilities?.options ?? []
    if (!options.length) return
    const saved = preferences.reasoningByAgentModel[JSON.stringify([agentId, model])]
    const current = options.find((option) => option.id === saved)?.id
      ?? options.find((option) => option.id === capabilities?.default)?.id
      ?? options[0].id
    const index = options.findIndex((option) => option.id === current)
    const next = options[(index + 1) % options.length]
    if (next) preferences.setReasoningEffort(agentId, model, next.id)
  }, [])

  const cycleReviewPolicy = useCallback((): void => {
    const preferences = useComposerPreferences.getState()
    preferences.setReviewPolicy(preferences.reviewPolicy === 'review_at_task_end'
      ? 'review_each_issue'
      : 'review_at_task_end')
  }, [])

  useEffect(() => {
    const media = window.matchMedia('(max-width: 700px)')
    const onChange = (event: MediaQueryListEvent): void => {
      setMobileNavigation(event.matches)
      if (!event.matches) setMobileNavigationOpen(false)
    }
    media.addEventListener('change', onChange)
    return () => media.removeEventListener('change', onChange)
  }, [])

  useLayoutEffect(() => {
    if (mobileNavigation && mobileNavigationOpen) mobileNavigationCloseRef.current?.focus()
  }, [mobileNavigation, mobileNavigationOpen])

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
    if (ready || !workspaceError) return
    const retry = window.setTimeout(() => { void load() }, 1500)
    return () => window.clearTimeout(retry)
  }, [ready, workspaceError, load])

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
          taskResultNotices: state.taskResultNotices.filter((notice) => projects.some((project) => project.id === notice.projectId)),
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

  // F1 is captured separately so dialogs and terminal widgets that contain
  // their own key events cannot allow the browser help action to escape.
  useEffect(() => {
    const onF1 = (event: KeyboardEvent): void => {
      if (event.key !== 'F1') return
      event.preventDefault()
      const state = useStore.getState()
      if (event.repeat || !state.ready || state.workspaceSwitching || state.settingsOpen) return
      const target = event.target as HTMLElement | null
      if (target?.closest('[data-terminal]') || document.querySelector('dialog:modal')) return
      setCommandPaletteOpen(true)
    }
    window.addEventListener('keydown', onF1, true)
    return () => window.removeEventListener('keydown', onF1, true)
  }, [])

  // Capture fields stop propagation so recording a shortcut never invokes it.
  useEffect(() => {
    const actions: Record<ShortcutId, () => void> = {
      toggleSidebar: toggleNavigation,
      focusTaskComposer,
      cycleTaskStyle: cycleTaskComposerStyle,
      cycleReviewPolicy,
      cycleThinking
    }
    const onKey = (event: KeyboardEvent): void => {
      // Auto-repeat fires while a chord is held down; a shortcut is an action
      // per press, so only the first event of a hold counts.
      if (event.repeat || useStore.getState().workspaceSwitching) return
      if (commandPaletteOpen) return
      if (isTerminalShortcut(event)) {
        event.preventDefault()
        if (projectId) {
          setSettingsOpen(false)
          if (terminalOpen) setTerminalOpen(false)
          else openTerminal()
        }
        return
      }
      if ((event.target as HTMLElement)?.closest('[data-terminal]')) return
      if (event.key === 'Escape' && mobileNavigation && mobileNavigationOpen) {
        event.preventDefault()
        closeMobileNavigation(true)
        return
      }
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
  }, [keybindings, toggleNavigation, focusTaskComposer, cycleTaskComposerStyle, cycleReviewPolicy, cycleThinking, settingsOpen, setSettingsOpen, projectId,
    mobileNavigation, mobileNavigationOpen, closeMobileNavigation, commandPaletteOpen, terminalOpen, openTerminal])

  useEffect(() => {
    const offEvent = window.anvil.tasks.onEvent(applyEvent)
    const offUpdate = window.anvil.tasks.onUpdated(applyTaskUpdate)
    const offResultNotice = window.anvil.taskResultNotices.onChanged(applyTaskResultNoticeChange)
    return () => {
      offEvent()
      offUpdate()
      offResultNotice()
    }
  }, [applyEvent, applyTaskUpdate, applyTaskResultNoticeChange])

  if (!ready) return <AppSkeleton />

  // Collapsing closes the grid column while the sidebar slides out behind it,
  // so the workspace grows in step with the panel leaving.
  return (
    <>
      <div
        className={cn(
          'relative isolate grid h-full min-h-0 grid-rows-[minmax(0,1fr)] overflow-hidden transition-[grid-template-columns] duration-[180ms] ease-[ease] motion-reduce:transition-none',
          settingsOpen
            ? 'grid-cols-[304px_1fr] max-[700px]:grid-cols-1 max-[700px]:grid-rows-[auto_minmax(0,1fr)]'
            : sidebarCollapsed
              ? 'grid-cols-[0_1fr] max-[700px]:grid-cols-1'
              : 'grid-cols-[304px_1fr] max-[700px]:grid-cols-1'
        )}
      >
        <OverviewBackground />
        {!settingsOpen && mobileNavigation && mobileNavigationOpen && (
          <button
            type="button"
            aria-label="Dismiss navigation"
            className="fixed inset-0 z-20 bg-black/45"
            onClick={() => closeMobileNavigation(true)}
          />
        )}
        <div className="contents" inert={switching}>
          <Sidebar
            mobileNavigation={mobileNavigation}
            mobileNavigationOpen={mobileNavigationOpen}
            mobileNavigationCloseRef={mobileNavigationCloseRef}
            onCloseMobileNavigation={() => closeMobileNavigation(true)}
            onNavigate={() => closeMobileNavigation(false)}
            terminalAvailable={Boolean(projectId)} onOpenTerminal={() => {
            if (!projectId) return
            openTerminal()
            if (mobileNavigation) closeMobileNavigation(false)
          }} />
        </div>
        <div ref={workspaceRef} tabIndex={-1} aria-hidden={mobileNavigation && mobileNavigationOpen || undefined}
          className={cn('relative flex min-w-0 min-h-0 outline-none', settingsOpen && 'hidden')}
          inert={settingsOpen || switching || (mobileNavigation && mobileNavigationOpen)}>
          <div className="min-h-0 min-w-0 flex-1"><Workspace key={workspaceId} mobileNavigation={mobileNavigation}
            mobileNavigationOpen={mobileNavigationOpen} navigationButtonRef={mobileNavigationButtonRef} onToggleNavigation={toggleNavigation} /></div>
          {!settingsOpen && terminalCreated && projectId && <RightSidePanel key={`${workspaceId}:${projectId}`} projectId={projectId} visible={terminalOpen} onClose={() => setTerminalOpen(false)} />}
          {taskMenu && <TaskContextMenu key={`${taskMenu.taskId}:${taskMenu.x}:${taskMenu.y}`} />}
        </div>
        {settingsOpen && <div className="contents" inert={switching}><Suspense fallback={<p role="status" className="p-5 text-sm text-dim">Loading settings…</p>}><SettingsPage key={workspaceId} /></Suspense></div>}
      </div>
      {switching && <div role="status" className="fixed bottom-4 right-4 z-50 border border-line bg-canvas p-3 text-sm shadow-lg">Switching workspace…</div>}
      {workspaceError && <div role="alert" className="fixed bottom-4 right-4 z-50 rounded border border-line bg-canvas p-3 text-sm shadow-lg">
        <p>{workspaceError}</p>
        <button className="mt-2 text-accent" onClick={() => { void load() }}>Retry workspace</button>
      </div>}
      <CommandPalette open={commandPaletteOpen} onClose={() => setCommandPaletteOpen(false)} onOpenTerminal={openTerminal} />
    </>
  )
}
