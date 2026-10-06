import { WorkspaceAgentAccounts } from './WorkspaceAgentAccounts'
import { version } from '../../package.json'
import type { JSX } from 'react'
import { SETTINGS_SECTIONS } from '../settings-sections'
import { lazy, Suspense, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ComposerModelPicker } from './ComposerModelPicker'
import { OverviewBackgroundPicker, type OverviewAppearance } from './OverviewBackgroundPicker'
import { GitHubSettings } from './GitHubSettings'
import { Select } from './Select'
import { asciiBar } from './AsciiMeter'
import { OptionCards, SettingRow, SettingsPanel, ToggleRow } from './settings-controls'
import { acceleratorFromEvent, IS_MAC } from '../keys'
import { autosave, retryAutosave, useSettingsAutosave } from '../state/settings-autosave'
import { useStore } from '../state/store'
import { useComposerPreferences } from '../state/composer-preferences'
import { btn, cn, field } from '../ui'
import { DEFAULT_KEYBINDINGS, formatAccelerator, SHORTCUTS } from '@anvil/protocol/keybindings'
import type { Keybindings, ShortcutDefinition } from '@anvil/protocol/keybindings'
import { DEFAULT_FONT_SIZE, MIN_FONT_SIZE, MAX_FONT_SIZE, normalizeFontSize } from '@anvil/protocol/appearance'
import { DEFAULT_EMBEDDING_MODEL, DEFAULT_OLLAMA_BASE_URL } from '@anvil/protocol/memory-settings'
import { DEFAULT_DIFF_THEMES, DIFF_THEME_NAMES, type DiffThemes } from '@anvil/protocol/diff-themes'
import { serverAddress, type ServerTarget } from '@anvil/protocol/server-address'
import type { DesktopServerConnectionState } from '@anvil/protocol/desktop-requests'
import type { ConnectionsStatus, RebaseMode, Settings } from '@anvil/protocol/types'

const DiffThemePreview = lazy(async () => ({
  default: (await import('./DiffThemePreview')).DiffThemePreview
}))

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback
}

function DesktopServerConnectionSettings(): JSX.Element | null {
  const serverConnection = window.anvil.serverConnection
  const [connection, setConnection] = useState<DesktopServerConnectionState | null>(null)
  const [mode, setMode] = useState<ServerTarget['mode']>('local')
  const [remoteUrl, setRemoteUrl] = useState('')
  const [pending, setPending] = useState(false)
  const [requestError, setRequestError] = useState('')
  const [reconnecting, setReconnecting] = useState(false)
  const requestInFlight = useRef(false)

  useEffect(() => {
    if (!serverConnection) return
    let active = true
    void serverConnection.get().then((state) => {
      if (!active) return
      setConnection(state)
      setMode(state.target.mode)
      if (state.target.mode === 'remote') setRemoteUrl(state.target.url)
    }).catch((error) => {
      if (active) setRequestError(errorMessage(error, 'Could not load the desktop server target.'))
    })
    return () => { active = false }
  }, [serverConnection])

  if (!serverConnection) return null

  const apply = async (target: ServerTarget): Promise<void> => {
    if (requestInFlight.current) return
    let normalized = target
    if (target.mode === 'remote') {
      try {
        normalized = { mode: 'remote', url: serverAddress(target.url.trim()) }
      } catch (error) {
        setRequestError(errorMessage(error, 'Enter a valid Anvil server URL.'))
        return
      }
    }
    requestInFlight.current = true
    setPending(true)
    setReconnecting(false)
    setRequestError('')
    try {
      const next = await serverConnection.set(normalized)
      setConnection(next)
      setMode(next.target.mode)
      if (next.target.mode === 'remote') setRemoteUrl(next.target.url)
      setReconnecting(true)
    } catch (error) {
      setRequestError(errorMessage(error, 'Could not connect to the Anvil server.'))
    } finally {
      requestInFlight.current = false
      setPending(false)
    }
  }

  return (
    <section aria-labelledby="desktop-server-target" className="mb-6 border border-line bg-raised">
      <h3 id="desktop-server-target" className="border-b border-line px-4 py-2.5 font-mono text-[11px] font-medium tracking-[0.12em] uppercase text-dim">Connect to remote server</h3>
      <div className="px-4 pt-3.5">
      <p className="mb-4 text-xs text-dim">Choose the server used by this Electron client. Applying a change verifies the server, saves the choice for future launches, and reloads Anvil to reconnect.</p>

      <div className="mb-1 border border-line-strong bg-canvas p-3 text-xs">
        <span className="block font-mono text-[10px] tracking-[0.12em] text-dim uppercase">Active client target</span>
        {connection
          ? <><strong className="mt-1 block">{connection.target.mode === 'local' ? 'Built-in local server' : 'Remote server'}</strong><code className="mt-1 block break-all text-dim">{connection.url}</code></>
          : <span role="status" className="mt-1 block text-dim">Loading desktop server target…</span>}
      </div>

      </div>
      <OptionCards
        ariaLabel="Electron server target"
        name="electron-server-target"
        value={mode}
        disabled={!connection || pending}
        onChange={(value) => {
          setMode(value as ServerTarget['mode'])
          setRequestError('')
          setReconnecting(false)
        }}
        options={[
          { value: 'local', label: 'Built-in local server', description: 'Run and connect to the Anvil server on this computer.' },
          { value: 'remote', label: 'Remote server', description: 'Connect this desktop client to another Anvil HTTP or HTTPS server.' }
        ]}
      />

      <div className="px-4 pb-3.5">
      {mode === 'remote' ? (
        <form noValidate onSubmit={(event) => { event.preventDefault(); void apply({ mode: 'remote', url: remoteUrl }) }}>
          <label className={field.wrap}>
            <span className={field.label}>Remote Anvil URL</span>
            <input
              aria-label="Remote Anvil URL"
              className={field.sized}
              type="url"
              inputMode="url"
              placeholder="https://anvil.example.com"
              value={remoteUrl}
              disabled={pending}
              spellCheck={false}
              onChange={(event) => {
                setRemoteUrl(event.target.value)
                setRequestError('')
                setReconnecting(false)
              }}
            />
            <small className={field.hint}>Enter the HTTP or HTTPS base address without a path, query, fragment, or credentials.</small>
          </label>
          <button className={btn.primary} type="submit" disabled={!connection || pending || remoteUrl.trim().length === 0}>
            {pending ? 'Connecting…' : 'Connect'}
          </button>
        </form>
      ) : (
        <button className={btn.primary} type="button" disabled={!connection || pending || connection.target.mode === 'local'} onClick={() => { void apply({ mode: 'local' }) }}>
          {pending ? 'Connecting…' : 'Use built-in local server'}
        </button>
      )}

      {pending && <p role="status" className="mt-3 text-xs text-dim">Verifying the server before reconnecting…</p>}
      {reconnecting && <p role="status" className="mt-3 text-xs text-ok">Server ready. Reloading Anvil…</p>}
      {requestError && <p role="alert" className="mt-3 text-xs text-danger">{requestError}</p>}
      </div>
    </section>
  )
}

function ConnectionsSettings({ workspaceId }: { workspaceId: string | null }): JSX.Element {
  const [status, setStatus] = useState<ConnectionsStatus | null>(null)
  const [password, setPassword] = useState('')
  const [passwordPurpose, setPasswordPurpose] = useState<'lan' | 'tailscale' | 'replace' | null>(null)
  const [requestError, setRequestError] = useState('')
  const statusRevision = useRef(0)
  const requestInFlight = useRef(false)

  useEffect(() => {
    let active = true
    setStatus(null)
    setPassword('')
    setPasswordPurpose(null)
    setRequestError('')
    if (!workspaceId) return
    statusRevision.current += 1
    const unsubscribe = window.anvil.connections.onChanged((change) => {
      if (active && change.workspaceId === workspaceId) {
        statusRevision.current += 1
        setStatus(change.status)
        setRequestError('')
      }
    })
    // Rebinding disconnects SSE, so the final connection status can be missed.
    const unsubscribeReady = window.anvil.app.onReady(() => {
      const revision = ++statusRevision.current
      void window.anvil.connections.status(workspaceId).then((next) => {
        if (active && revision === statusRevision.current) {
          setStatus(next)
          setRequestError('')
        }
      }).catch((error) => {
        if (active && revision === statusRevision.current) {
          setRequestError(errorMessage(error, 'Could not load connection settings.'))
        }
      })
    })
    return () => {
      active = false
      statusRevision.current += 1
      unsubscribe()
      unsubscribeReady()
    }
  }, [workspaceId])

  useEffect(() => {
    if (!workspaceId || !status?.pending) return
    let active = true
    let refreshing = false
    const timer = setInterval(() => {
      if (refreshing || requestInFlight.current) return
      refreshing = true
      const revision = statusRevision.current
      void window.anvil.connections.status(workspaceId).then((next) => {
        if (active && revision === statusRevision.current) {
          statusRevision.current += 1
          setStatus(next)
          setRequestError('')
        }
      }).catch((error) => {
        if (active && revision === statusRevision.current) {
          setRequestError(errorMessage(error, 'Could not refresh connection settings.'))
        }
      }).finally(() => { refreshing = false })
    }, 2_000)
    return () => {
      active = false
      clearInterval(timer)
    }
  }, [workspaceId, status?.pending])

  const configure = async (allowOtherDevices: boolean, nextPassword?: string, tailscaleHttps?: boolean): Promise<void> => {
    if (!workspaceId || !status || requestInFlight.current) return
    requestInFlight.current = true
    const revision = ++statusRevision.current
    const previous = status
    setRequestError('')
    setStatus({ ...status, pending: true, error: undefined })
    try {
      const next = await window.anvil.connections.configure({
        workspaceId,
        allowOtherDevices,
        ...(tailscaleHttps !== undefined ? { tailscaleHttps } : {}),
        ...(nextPassword !== undefined ? { password: nextPassword } : {})
      })
      // A completion event can arrive before the configure response.
      if (revision === statusRevision.current) setStatus(next)
      if (nextPassword !== undefined) setPasswordPurpose(null)
    } catch (error) {
      if (revision === statusRevision.current) {
        setStatus({ ...previous, pending: false })
        setRequestError(errorMessage(error, 'Could not change connection settings.'))
      }
    } finally {
      requestInFlight.current = false
      if (nextPassword !== undefined) setPassword('')
    }
  }

  const submitPassword = (): void => {
    if (!password) {
      setRequestError('Enter a password before continuing.')
      return
    }
    if (!status) return
    void configure(
      passwordPurpose === 'lan' ? true : status.allowOtherDevices,
      password,
      passwordPurpose === 'tailscale' ? true : status.tailscaleHttps
    )
  }

  const pending = status?.pending ?? false
  const tailscaleOnly = status?.headlessAccess === 'tailscale'
  const showPasswordForm = status !== null && !status.headlessAccess && (!status.passwordConfigured || passwordPurpose !== null)
  return (
    <div>
      <DesktopServerConnectionSettings />
      <section aria-labelledby="server-access-settings" className="mb-6 border border-line bg-raised">
      <h3 id="server-access-settings" className="border-b border-line px-4 py-2.5 font-mono text-[11px] font-medium tracking-[0.12em] uppercase text-dim">Server access</h3>
      <p className="border-b border-line px-4 py-3 text-xs text-dim">Configure how other devices can reach the server currently shown above.</p>
      <div className="divide-y divide-line">
      <ToggleRow
        title="Allow other devices"
        description={<>Make Anvil available over HTTP on port 4780 to devices on this local network. Remote requests require the username <code>anvil</code> and your password.</>}
        checked={status?.allowOtherDevices ?? false}
        disabled={!status || Boolean(status.headlessAccess) || pending}
        onChange={(checked) => {
          if (checked && !status?.passwordConfigured) {
            setPasswordPurpose('lan')
            setRequestError('')
          } else {
            void configure(checked)
          }
        }}
      >
        <small className="mt-2 block text-xs text-warn">Trusted LAN only. Credentials and activity are not encrypted. Use Tailscale HTTPS on shared or remote networks.</small>
      </ToggleRow>

      <ToggleRow
        title="Tailscale HTTPS"
        description={tailscaleOnly
          ? 'Access is managed by Tailscale. No Anvil username or password is required.'
          : 'Access Anvil from another network using Tailscale. Install and connect Tailscale on this computer and your phone. Your Anvil password is still required.'}
        checked={status?.tailscaleHttps ?? false}
        disabled={!status || Boolean(status.headlessAccess) || pending}
        onChange={(checked) => {
          if (checked && !status?.passwordConfigured) {
            setPasswordPurpose('tailscale')
            setRequestError('')
          } else {
            void configure(status?.allowOtherDevices ?? false, undefined, checked)
          }
        }}
      >
        {status?.headlessAccess && <small className="mt-2 block text-xs text-dim">Connection access is managed by the server startup command.</small>}
      </ToggleRow>
      </div>
      <div className="border-t border-line px-4 py-3.5 empty:hidden">
      {status?.tailscaleUrl && (
        <label className={field.wrap}>
          <span className={field.label}>Tailscale HTTPS address</span>
          <input className={field.sized} readOnly value={status.tailscaleUrl} onFocus={(event) => event.target.select()} />
          <small className={field.hint}>Open this address on your phone while connected to Tailscale.</small>
        </label>
      )}

      {!status && !requestError && <p role="status" className="text-xs text-dim">Loading connection settings…</p>}
      {status && !status.headlessAccess && <div className="flex items-center justify-between gap-3 text-xs text-dim">
        <p>{status.passwordConfigured ? 'A server password is configured.' : 'Set a server password before enabling LAN or Tailscale access.'}</p>
        {status.passwordConfigured && passwordPurpose === null && (
          <button className={cn(btn.ghost, 'flex-none')} disabled={pending} onClick={() => {
            setPassword('')
            setPasswordPurpose('replace')
            setRequestError('')
          }}>Replace password</button>
        )}
      </div>}

      {showPasswordForm && (
        <form className="mt-5 border-t border-line pt-5" onSubmit={(event) => { event.preventDefault(); submitPassword() }}>
          <label className={field.wrap}>
            <span className={field.label}>{status.passwordConfigured ? 'New server password' : 'Server password'}</span>
            <input
              aria-label={status.passwordConfigured ? 'New server password' : 'Server password'}
              className={field.sized}
              type="password"
              autoComplete="new-password"
              value={password}
              disabled={pending}
              onChange={(event) => setPassword(event.target.value)}
            />
            <small className={field.hint}>Stored only as an Argon2id hash. Anvil never saves the plaintext password.</small>
          </label>
          <div className="flex items-center gap-3">
            <button className={btn.primary} type="submit" disabled={pending || password.length === 0}>
              {status.passwordConfigured
                ? 'Save new password'
                : passwordPurpose === 'lan'
                  ? 'Set password and enable LAN'
                  : passwordPurpose === 'tailscale'
                    ? 'Set password and enable Tailscale'
                    : 'Set server password'}
            </button>
            {status.passwordConfigured && <button className={btn.ghost} type="button" disabled={pending} onClick={() => {
              setPassword('')
              setPasswordPurpose(null)
              setRequestError('')
            }}>Cancel</button>}
          </div>
        </form>
      )}

      {status?.tailscaleSetupUrl && (
        <label className={field.wrap}>
          <span className={field.label}>Tailscale setup link</span>
          <input className={field.sized} readOnly value={status.tailscaleSetupUrl} onFocus={(event) => event.target.select()} />
          <small className={field.hint}>Open this link in your browser to approve HTTPS, then enable Tailscale HTTPS again.</small>
        </label>
      )}
      {pending && <p role="status" className="mt-4 text-xs text-dim">Changing connection access…</p>}
      {(requestError || status?.error) && <p role="alert" className="mt-4 text-xs text-danger">{requestError || status?.error}</p>}
      </div>
      </section>
    </div>
  )
}

/** Click, then press the chord you want. Escape leaves the binding alone. */
function ShortcutField({
  shortcut,
  accelerator,
  onChange
}: {
  shortcut: ShortcutDefinition
  accelerator: string
  onChange: (accelerator: string) => void
}): JSX.Element {
  const [capturing, setCapturing] = useState(false)
  return (
    <div className="flex items-center gap-3 px-4 py-3">
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <strong className="text-sm font-medium">{shortcut.label}</strong>
        <small className="text-xs text-dim">{shortcut.hint}</small>
      </span>
      {accelerator !== shortcut.defaultAccelerator && (
        <button className={btn.text} onClick={() => onChange(shortcut.defaultAccelerator)}>
          Reset
        </button>
      )}
      <button
        className={cn(
          'h-[30px] min-w-[92px] flex-none border border-b-2 px-2.5 font-mono text-xs focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
          capturing ? 'border-accent bg-ember-950 text-ember-400' : 'border-line-strong bg-canvas text-fg hover:border-dim'
        )}
        onClick={() => setCapturing(true)}
        onBlur={() => setCapturing(false)}
        onKeyDown={(event) => {
          if (!capturing || event.repeat) return
          // Swallowed so the chord being recorded does not also trigger the
          // shortcut it is bound to.
          event.preventDefault()
          event.stopPropagation()
          if (event.key === 'Escape') {
            setCapturing(false)
            return
          }
          const next = acceleratorFromEvent(event.nativeEvent)
          if (!next) return
          onChange(next)
          setCapturing(false)
        }}
      >
        {capturing ? 'Press keys…' : formatAccelerator(accelerator, IS_MAC)}
      </button>
    </div>
  )
}

export function SettingsPage(): JSX.Element {
  const pageRef = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => { pageRef.current?.focus() }, [])
  const workspaceId = useStore((s) => s.activeWorkspaceId)
  const workspaceName = useStore((s) => s.workspaces.find((workspace) => workspace.id === s.activeWorkspaceId)?.name)
  const section = useStore((s) => s.settingsSection)
  const [memoryEnabled, setMemoryEnabled] = useState(false)
  const [memoryEmbeddingModel, setMemoryEmbeddingModel] = useState(DEFAULT_EMBEDDING_MODEL)
  const [ollamaBaseUrl, setOllamaBaseUrl] = useState(DEFAULT_OLLAMA_BASE_URL)
  const [fontSize, setFontSize] = useState(DEFAULT_FONT_SIZE)
  const [diffThemes, setDiffThemes] = useState<DiffThemes>(DEFAULT_DIFF_THEMES)
  const selectProject = useStore((s) => s.setSettingsProject)
  const settings = useStore((s) => s.settings)
  const agents = useStore((s) => s.agents)
  const composer = useComposerPreferences()
  const projects = useStore((s) => s.projects)
  const activeProjectId = useStore((s) => s.settingsProjectId)
  const removeProject = useStore((s) => s.removeProject)
  const setSettingsOpen = useStore((s) => s.setSettingsOpen)

  const [autoCompactContext, setAutoCompactContext] = useState(settings?.autoCompactContext ?? true)
  const [contextCompactionThreshold, setContextCompactionThreshold] = useState(settings?.contextCompactionThreshold ?? 75)
  const [confirmRebase, setConfirmRebase] = useState(settings?.confirmRebase ?? true)
  const [rebaseMode, setRebaseMode] = useState<RebaseMode>(settings?.rebaseMode ?? 'manual')
  const [keybindings, setKeybindings] = useState<Keybindings>(
    settings?.keybindings ?? DEFAULT_KEYBINDINGS
  )
  const edits = useSettingsAutosave((s) => s.edits)
  const workspaceKey = `workspace:${workspaceId}`
  const relevantEdits = Object.entries(edits).filter(([key]) => key === workspaceKey || projects.some((p) => key === `project:${workspaceId}:${p.id}`))
  const saving = relevantEdits.some(([, edit]) => edit.status === 'pending')
  const failed = relevantEdits.filter(([, edit]) => edit.status === 'error')
  const saved = relevantEdits.length > 0 && !saving && failed.length === 0
  const persist = (patch: Partial<Settings>, draft: Record<string, unknown> = patch): void => {
    if (settings && workspaceId) autosave(workspaceKey, patch, draft)
  }
  const [projectRemovalError, setProjectRemovalError] = useState('')
  const initialSettings = useRef<Partial<Settings> | null>(null)
  const [appearance, setAppearance] = useState<OverviewAppearance>({
    overviewBackgroundMode: 'color', overviewBackgroundColor: '#0c0d10', overviewWallpaperId: null
  })
  useEffect(() => { initialSettings.current = null }, [workspaceId])
  useEffect(() => {
    if (!settings || initialSettings.current) return
    const pending = useSettingsAutosave.getState().edits[`workspace:${workspaceId}`]
    const hydrated = { ...settings, ...(pending?.status !== 'saved' ? pending?.draft : {}) }
    initialSettings.current = hydrated
    setAppearance({ overviewBackgroundMode: hydrated.overviewBackgroundMode,
      overviewBackgroundColor: hydrated.overviewBackgroundColor, overviewWallpaperId: hydrated.overviewWallpaperId })
    setMemoryEnabled(hydrated.memoryEnabled)
    setMemoryEmbeddingModel(hydrated.memoryEmbeddingModel)
    setOllamaBaseUrl(hydrated.ollamaBaseUrl)
    setFontSize(hydrated.fontSize)
    setDiffThemes(hydrated.diffThemes ?? DEFAULT_DIFF_THEMES)
    setRebaseMode(hydrated.rebaseMode)
    setConfirmRebase(hydrated.confirmRebase)
    setAutoCompactContext(hydrated.autoCompactContext ?? true)
    setContextCompactionThreshold(hydrated.contextCompactionThreshold ?? 75)
    setKeybindings(hydrated.keybindings)
  }, [settings, workspaceId])

  const activeProject = projects.find((p) => p.id === activeProjectId) ?? projects[0]

  const currentSection = SETTINGS_SECTIONS.find((item) => item.id === section)!

  const statusTone = failed.length > 0 ? 'bg-danger-tint text-danger-text' : saving ? 'bg-run-tint text-run-text' : saved ? 'bg-ok-tint text-ok-text' : 'bg-overlay text-dim'

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col bg-canvas" data-testid="settings-page" ref={pageRef} tabIndex={-1}>
      <main className="min-h-0 flex-1 overflow-y-auto px-8 py-8 max-[600px]:px-5" aria-labelledby="settings-section-title">
        <div className="mx-auto max-w-[760px]">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
            <p className="min-w-0 break-words font-mono text-[11px] tracking-[0.12em] text-dim uppercase" aria-label="Settings workspace">Workspace: <span className="text-fg normal-case tracking-normal">{workspaceName}</span></p>
            <span className={cn('inline-flex h-[22px] shrink-0 items-center gap-1.5 px-2 font-mono text-[11px]', statusTone)}>
              <span aria-hidden="true">{failed.length > 0 ? '✕' : saving ? '⠿' : saved ? '✓' : '·'}</span>
              <span role="status">{saving ? 'Saving settings…' : saved ? 'Saved' : 'Changes save automatically.'}</span>
            </span>
          </div>
          <h2 id="settings-section-title" className="font-mono text-[28px] font-semibold tracking-[-0.02em]">{currentSection.label}</h2>
          <p className="mb-6 mt-2 text-sm leading-normal text-dim">{currentSection.description}</p>
          {(projectRemovalError || failed.length > 0) && <div aria-live="polite" className="mb-6 min-w-0 space-y-2 break-words border border-danger/40 bg-danger-tint px-4 py-3 text-xs">
            {projectRemovalError && <p role="alert" className="text-danger-text">{projectRemovalError}</p>}
            {failed.length > 0 && <p role="alert" className="text-danger-text">Could not save settings. Your changes are retained. <button className={btn.text} onClick={() => failed.forEach(([key]) => retryAutosave(key))}>Retry</button></p>}
          </div>}
          {!settings && <p role="status" className="mb-4 font-mono text-xs text-dim">Loading settings…</p>}
          {(section === 'general' || section === 'source-control') && projects.length > 0 && (
            <SettingsPanel title="Active project">
              <SettingRow title="Project" description="Project settings below apply to this project.">
                <label className="block min-w-[200px]">
                  <span className="sr-only">Project</span>
                  <Select aria-label="Project" value={activeProject?.id ?? ''} onChange={(event) => selectProject(event.target.value)}>
                    {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
                  </Select>
                </label>
              </SettingRow>
            </SettingsPanel>
          )}
          <fieldset className="min-w-0" disabled={!settings}>
            {section === 'providers' && <>
              <SettingsPanel title="Session defaults">
                <SettingRow title={<span id="session-default-title">Default for new sessions</span>} description="Provider and model used when you start a task in this workspace.">
                  <ComposerModelPicker
                    agents={agents}
                    agentId={composer.agentId}
                    selectedModels={composer.modelsByAgent}
                    value={composer.modelsByAgent[composer.agentId] ?? ''}
                    onChange={composer.setSelection}
                  />
                </SettingRow>
                {composer.saveError && <p role="alert" className="px-4 py-2 text-xs text-danger">{composer.saveError}</p>}
              </SettingsPanel>
              <WorkspaceAgentAccounts />
              <SettingsPanel title="Context">
                <ToggleRow
                  title={<span id="session-context-title">Auto-compact task context</span>}
                  description="Compact the model session before resuming when it reaches the threshold."
                  checked={autoCompactContext}
                  onChange={(value) => {
                    setAutoCompactContext(value)
                    persist({ autoCompactContext: value })
                  }}
                />
                <SettingRow
                  title="Context threshold"
                  description={<span className="font-mono">compacts at <span aria-hidden="true" className="tracking-[-0.02em] text-warn">{asciiBar(contextCompactionThreshold / 100, 10)}</span> {contextCompactionThreshold}%</span>}
                  disabled={!autoCompactContext}
                >
                  <label className="inline-flex h-8 w-28 shrink-0 items-center border border-line-strong bg-canvas focus-within:border-accent">
                    <input
                      aria-label="Context threshold (%)"
                      className="h-full min-w-0 flex-1 bg-transparent px-2.5 text-right font-mono text-sm text-fg tabular-nums outline-none disabled:cursor-not-allowed"
                      type="number" min={1} max={100} step={1} disabled={!autoCompactContext}
                      value={contextCompactionThreshold} onChange={(event) => {
                        const value = Number(event.target.value)
                        if (!Number.isInteger(value) || value < 1 || value > 100) return
                        setContextCompactionThreshold(value)
                        persist({ contextCompactionThreshold: value })
                      }}
                    />
                    <span aria-hidden="true" className="pr-2.5 font-mono text-xs text-dim">%</span>
                  </label>
                </SettingRow>
              </SettingsPanel>
            </>}
            {section === 'general' && activeProject && (
              <SettingsPanel title={<><span aria-hidden="true">▲ </span>Danger zone</>} tone="danger">
                <SettingRow
                  title={<>Remove <strong className="font-mono">{activeProject.name}</strong> and its task history</>}
                  description="Deletes its task history from Anvil. Files on disk stay."
                >
                  <button
                    className={btn.danger}
                    onClick={() => {
                      void removeProject(activeProject.id).then(() => setSettingsOpen(false)).catch((error) => {
                        setProjectRemovalError(error instanceof Error ? error.message : 'Could not remove project.')
                      })
                    }}
                  >
                    Remove
                  </button>
                </SettingRow>
              </SettingsPanel>
            )}
            <div hidden={section !== 'source-control'}>
              <SettingsPanel title="Rebase mode">
                <OptionCards
                  ariaLabel="Rebase mode"
                  value={rebaseMode}
                  onChange={(value) => {
                    const mode = value as RebaseMode
                    setRebaseMode(mode)
                    persist({ rebaseMode: mode })
                  }}
                  options={[
                    {
                      value: 'manual',
                      label: 'Manual',
                      description: 'Choose what happens to each commit. Rebase opens a small interactive editor and Anvil performs the rebase.'
                    },
                    {
                      value: 'agent',
                      label: 'Agent',
                      description: 'Let the agent rewrite the history. Rebase hands the branch to the agent that wrote the code and accepts its result.'
                    }
                  ]}
                />
                <ToggleRow
                  title="Ask before handing a rebase to an agent"
                  checked={confirmRebase}
                  onChange={(value) => {
                    setConfirmRebase(value)
                    persist({ confirmRebase: value })
                  }}
                />
              </SettingsPanel>
              <GitHubSettings />
            </div>
            {section === 'shortcuts' && <SettingsPanel title="Shortcuts" aside="Select a shortcut, then press the keys you want to use. Escape cancels.">
              {SHORTCUTS.map((shortcut) => (
                <ShortcutField
                  key={shortcut.id}
                  shortcut={shortcut}
                  accelerator={keybindings[shortcut.id]}
                  onChange={(accelerator) => {
                    const value = { ...keybindings, [shortcut.id]: accelerator }
                    setKeybindings(value)
                    persist({ keybindings: value })
                  }}
                />
              ))}
              <div className="flex items-center justify-between gap-3 px-4 py-3">
                <span className="text-sm text-dim">Open settings</span>
                <kbd className="border border-line px-2.5 py-1 font-mono text-xs text-dim">{formatAccelerator('Mod+,', IS_MAC)}</kbd>
              </div>
            </SettingsPanel>}
            {section === 'memory' && <SettingsPanel title="Project memory">
              <ToggleRow
                title="Enable project memory"
                description="Save completed task context and include relevant memories in future tasks. Off by default."
                checked={memoryEnabled}
                disabled={!settings}
                onChange={(value) => {
                  setMemoryEnabled(value)
                  persist({ memoryEnabled: value })
                }}
              />
              {memoryEnabled && <div className="grid gap-x-4 px-4 pt-3.5 min-[640px]:grid-cols-2">
                <label className={field.wrap}>
                  <span className={field.label}>Embedding model</span>
                  <input aria-label="Embedding model" className={cn(field.sized, 'font-mono text-xs')} list="embedding-models" value={memoryEmbeddingModel}
                    onChange={(event) => {
                      const value = event.target.value
                      setMemoryEmbeddingModel(value)
                      persist({ memoryEmbeddingModel: value.trim() }, { memoryEmbeddingModel: value })
                    }} spellCheck={false} />
                  <datalist id="embedding-models"><option value={DEFAULT_EMBEDDING_MODEL} /></datalist>
                  <small className={field.hint}>Choose or enter an installed Ollama model with 1,024-dimensional embeddings.</small>
                </label>
                <label className={field.wrap}>
                  <span className={field.label}>Ollama base URL</span>
                  <input aria-label="Ollama base URL" className={cn(field.sized, 'font-mono text-xs')} type="url" value={ollamaBaseUrl}
                    onChange={(event) => {
                      const value = event.target.value
                      setOllamaBaseUrl(value)
                      persist({ ollamaBaseUrl: value.trim() }, { ollamaBaseUrl: value })
                    }} spellCheck={false} />
                  <small className={field.hint}>Use the OpenAI-compatible endpoint, including /v1.</small>
                </label>
              </div>}
            </SettingsPanel>}
            {section === 'connections' && <ConnectionsSettings workspaceId={workspaceId} />}
            {section === 'display' && <>
              <SettingsPanel title="Text">
                <SettingRow title="Font size" description="Scales text and controls across Anvil automatically.">
                  <label className="block min-w-[160px]">
                    <span className="sr-only">Font size</span>
                    <Select aria-label="Font size" value={fontSize} onChange={(event) => {
                      const value = Number(event.target.value)
                      setFontSize(value)
                      persist({ fontSize: value })
                    }}>
                      {Array.from({ length: MAX_FONT_SIZE - MIN_FONT_SIZE + 1 }, (_, index) => MIN_FONT_SIZE + index).map((size) => (
                        <option key={size} value={size}>{size} px{size === DEFAULT_FONT_SIZE ? ' (Default)' : ''}</option>
                      ))}
                    </Select>
                  </label>
                </SettingRow>
                <div className="px-4 py-3.5">
                  <div className="border border-dashed border-line-strong bg-canvas px-4 py-3.5" style={{ fontSize: fontSize * DEFAULT_FONT_SIZE / normalizeFontSize(settings?.fontSize) }} aria-label="Font size preview">
                    <p className="font-medium">Your next task starts here.</p>
                    <p className="mt-1 text-dim">Add a feature or fix a bug.</p>
                  </div>
                </div>
              </SettingsPanel>
              <section className="mb-6 border border-line bg-raised" aria-labelledby="diff-themes-heading">
                <h3 id="diff-themes-heading" className="border-b border-line px-4 py-2.5 font-mono text-[11px] font-medium tracking-[0.12em] text-dim uppercase">Diff themes</h3>
                <div className="px-4 py-3.5">
                  <p className="mb-4 text-xs leading-normal text-dim">Choose the Shiki theme used to highlight code changes. The dark theme applies when the system is dark and the light theme when it is light.</p>
                  <div className="grid gap-x-4 min-[560px]:grid-cols-2">
                    <label className={field.wrap}>
                      <span className={field.label}>Dark diff theme</span>
                      <Select aria-label="Dark diff theme" value={diffThemes.dark} onChange={(event) => {
                        const value = { ...diffThemes, dark: event.target.value }
                        setDiffThemes(value)
                        persist({ diffThemes: value })
                      }}>
                        {DIFF_THEME_NAMES.map((name) => <option key={name} value={name}>{name}</option>)}
                      </Select>
                    </label>
                    <label className={field.wrap}>
                      <span className={field.label}>Light diff theme</span>
                      <Select aria-label="Light diff theme" value={diffThemes.light} onChange={(event) => {
                        const value = { ...diffThemes, light: event.target.value }
                        setDiffThemes(value)
                        persist({ diffThemes: value })
                      }}>
                        {DIFF_THEME_NAMES.map((name) => <option key={name} value={name}>{name}</option>)}
                      </Select>
                    </label>
                  </div>
                  <div className="mt-1" aria-label="Diff theme preview">
                    <Suspense fallback={<p className="text-xs text-dim">Loading diff preview…</p>}>
                      <DiffThemePreview themes={diffThemes} />
                    </Suspense>
                  </div>
                </div>
              </section>
              {settings && <OverviewBackgroundPicker value={appearance} onChange={(value) => {
                setAppearance(value)
                persist(Object.fromEntries(Object.entries(value).filter(([key, next]) => next !== appearance[key as keyof OverviewAppearance])))
              }} />}
            </>}
          </fieldset>
          <p className="mt-8 text-right font-mono text-[11px] text-faint" aria-label="Anvil version">anvil v{version}</p>
        </div>
      </main>
    </div>
  )
}
