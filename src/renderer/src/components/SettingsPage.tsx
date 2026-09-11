import { WorkspaceAgentAccounts } from './WorkspaceAgentAccounts'
import type { JSX } from 'react'
import { SETTINGS_SECTIONS } from '../settings-sections'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ProviderPicker } from './ProviderPicker'
import { ProviderModelSelect } from './ProviderModelSelect'
import { OverviewBackgroundPicker, type OverviewAppearance } from './OverviewBackgroundPicker'
import { GitHubSettings } from './GitHubSettings'
import { acceleratorFromEvent, IS_MAC } from '../keys'
import { autosave, retryAutosave, useSettingsAutosave } from '../state/settings-autosave'
import { useStore } from '../state/store'
import { btn, cn, field, hint, modal } from '../ui'
import { DEFAULT_KEYBINDINGS, formatAccelerator, SHORTCUTS } from '@shared/keybindings'
import type { Keybindings, ShortcutDefinition } from '@shared/keybindings'
import { DEFAULT_FONT_SIZE, MIN_FONT_SIZE, MAX_FONT_SIZE, normalizeFontSize } from '@shared/appearance'
import { DEFAULT_EMBEDDING_MODEL, DEFAULT_OLLAMA_BASE_URL } from '@shared/memory-settings'
import type { RebaseMode, Settings } from '@shared/types'

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
    <div className="flex gap-3 items-center py-2 border-t border-line [&:first-of-type]:border-t-0">
      <span className="flex flex-1 flex-col gap-0.5 min-w-0">
        <strong>{shortcut.label}</strong>
        <small className="text-xs text-dim">{shortcut.hint}</small>
      </span>
      {accelerator !== shortcut.defaultAccelerator && (
        <button className={btn.text} onClick={() => onChange(shortcut.defaultAccelerator)}>
          Reset
        </button>
      )}
      <button
        className={cn(
          'flex-none min-w-[92px] px-2.5 py-[5px] font-mono text-xs bg-canvas border',
          capturing ? 'text-accent border-accent' : 'text-fg border-line hover:border-accent'
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
  const selectProject = useStore((s) => s.setSettingsProject)
  const settings = useStore((s) => s.settings)
  const agents = useStore((s) => s.agents)
  const modelsByAgent = useStore((s) => s.modelsByAgent)
  const loadingModelsAgentId = useStore((s) => s.loadingModelsAgentId)
  const loadAgentModels = useStore((s) => s.loadAgentModels)
  const projects = useStore((s) => s.projects)
  const activeProjectId = useStore((s) => s.settingsProjectId)
  const removeProject = useStore((s) => s.removeProject)
  const setSettingsOpen = useStore((s) => s.setSettingsOpen)

  const [defaultAgentId, setDefaultAgentId] = useState(settings?.defaultAgentId ?? 'opencode')
  const [defaultModel, setDefaultModel] = useState(settings?.defaultModel ?? '')
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
    overviewBackgroundMode: 'color', overviewBackgroundColor: '#0d0f12', overviewWallpaperId: null
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
    setDefaultAgentId(hydrated.defaultAgentId)
    setDefaultModel(hydrated.defaultModel)
    setRebaseMode(hydrated.rebaseMode)
    setConfirmRebase(hydrated.confirmRebase)
    setAutoCompactContext(hydrated.autoCompactContext ?? true)
    setContextCompactionThreshold(hydrated.contextCompactionThreshold ?? 75)
    setKeybindings(hydrated.keybindings)
  }, [settings, workspaceId])

  const activeProject = projects.find((p) => p.id === activeProjectId) ?? projects[0]

  const catalogue = modelsByAgent[defaultAgentId]

  useEffect(() => {
    void loadAgentModels(defaultAgentId)
  }, [defaultAgentId, loadAgentModels])

  const currentSection = SETTINGS_SECTIONS.find((item) => item.id === section)!

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col bg-canvas" data-testid="settings-page" ref={pageRef} tabIndex={-1}>
      <main className="min-h-0 flex-1 overflow-y-auto px-8 py-7 max-[600px]:px-5" aria-labelledby="settings-section-title">
        <div className="mx-auto max-w-[720px]">
          <p className="mb-3 break-words text-xs text-dim" aria-label="Settings workspace">Workspace: {workspaceName}</p>
          <h2 id="settings-section-title" className="text-2xl font-semibold tracking-tight">{currentSection.label}</h2>
          <p className="mb-7 mt-2 text-sm text-dim">{currentSection.description}</p>
          <div aria-live="polite" className="mb-6 min-w-0 space-y-2 break-words text-xs">
            {projectRemovalError && <p role="alert" className="text-danger">{projectRemovalError}</p>}
            {failed.length > 0 && <p role="alert" className="text-danger">Could not save settings. Your changes are retained. <button className={btn.text} onClick={() => failed.forEach(([key]) => retryAutosave(key))}>Retry</button></p>}
            <span role="status" className={hint}>{saving ? 'Saving settings…' : saved ? 'Saved' : 'Changes save automatically.'}</span>
          </div>
          {!settings && <p role="status" className="mb-4 text-dim">Loading settings…</p>}
          {(section === 'general' || section === 'source-control') && projects.length > 0 && (
            <label className={cn(field.wrap, 'mb-6')}>
              <span className={field.label}>Project</span>
              <select aria-label="Project" className={field.sized} value={activeProject?.id ?? ''} onChange={(event) => selectProject(event.target.value)}>
                {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
              </select>
            </label>
          )}
          <fieldset className="min-w-0" disabled={!settings}>
            {section === 'providers' && <>
              <WorkspaceAgentAccounts />
              <label className="mb-3 flex items-center gap-2 text-sm">
                <input type="checkbox" checked={autoCompactContext} onChange={(event) => {
                  setAutoCompactContext(event.target.checked)
                  persist({ autoCompactContext: event.target.checked })
                }} />
                Auto-compact task context
              </label>
              <p className="mb-3 text-xs text-dim">Compacts the task's model session before resuming, without changing other tasks or the output log.</p>
              <label className={field.wrap}>
                <span className={field.label}>Context threshold (%)</span>
                <input className={field.control} type="number" min={1} max={100} step={1} disabled={!autoCompactContext}
                  value={contextCompactionThreshold} onChange={(event) => {
                    const value = Number(event.target.value)
                    if (!Number.isInteger(value) || value < 1 || value > 100) return
                    setContextCompactionThreshold(value)
                    persist({ contextCompactionThreshold: value })
                  }} />
              </label>
              <div className={field.wrap}>
                <span className={field.label}>Default agent</span>
                <ProviderPicker agents={agents} value={defaultAgentId} onChange={(value) => {
                  setDefaultAgentId(value)
                  setDefaultModel('')
                  persist({ defaultAgentId: value, defaultModel: '' })
                }} label="Default agent" />
              </div>

              <label className={field.wrap}>
                <span className={field.label}>Default model</span>
                <ProviderModelSelect
                  models={catalogue?.models ?? []}
                  value={defaultModel}
                  onChange={(value) => {
                    setDefaultModel(value)
                    persist({ defaultModel: value.trim() }, { defaultModel: value })
                  }}
                  loading={loadingModelsAgentId === defaultAgentId && !catalogue}
                  error={catalogue?.error}
                />
              </label>

            </>}
            {section === 'general' && <>
              {activeProject && (
                <div className="flex gap-3 items-center justify-between p-3 mt-2 text-xs text-dim border border-line">
                  <span>
                    Remove <strong>{activeProject.name}</strong> and its task history
                  </span>
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
                </div>
              )}

            </>}
            <div hidden={section !== 'source-control'}>
              <label className={field.wrap}>
                <span className={field.label}>Rebase mode</span>
                <select
                  className={field.sized}
                  value={rebaseMode}
                  onChange={(e) => {
                    const value = e.target.value as RebaseMode
                    setRebaseMode(value)
                    persist({ rebaseMode: value })
                  }}
                >
                  <option value="manual">Manual — choose what happens to each commit</option>
                  <option value="agent">Agent — let the agent rewrite the history</option>
                </select>
                <small className={field.hint}>
                  {rebaseMode === 'manual'
                    ? 'Rebase opens a small interactive editor and Anvil performs the rebase.'
                    : 'Rebase hands the branch to the agent that wrote the code and accepts its result.'}
                </small>
              </label>

              <label className={modal.toggle}>
                <input type="checkbox" checked={confirmRebase} onChange={(event) => {
                  const value = event.target.checked
                  setConfirmRebase(value)
                  persist({ confirmRebase: value })
                }} />
                <span>Ask before handing a rebase to an agent</span>
              </label>
              <GitHubSettings />
            </div>
            {section === 'shortcuts' && <>
              <p className="mb-4 text-xs text-dim">Select a shortcut, then press the keys you want to use. Escape cancels.</p>
              <div className={modal.section}>
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
              </div>

              <div className="flex items-center justify-between gap-3 border-t border-line py-3">
                <span>Open settings</span>
                <kbd className="border border-line bg-raised px-2.5 py-1 font-mono text-xs">{formatAccelerator('Mod+,', IS_MAC)}</kbd>
              </div>
            </>}
            {section === 'memory' && <>
              <label className={modal.toggle}>
                <input type="checkbox" checked={memoryEnabled} disabled={!settings} onChange={(event) => {
                  const value = event.target.checked
                  setMemoryEnabled(value)
                  persist({ memoryEnabled: value })
                }} />
                <span>
                  <strong className="block">Enable project memory</strong>
                  <small className={field.hint}>Save completed task context and include relevant memories in future tasks. Off by default.</small>
                </span>
              </label>
              {memoryEnabled && <div className="mt-6 space-y-5">
                <label className={field.wrap}>
                  <span className={field.label}>Embedding model</span>
                  <input aria-label="Embedding model" className={field.sized} list="embedding-models" value={memoryEmbeddingModel}
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
                  <input aria-label="Ollama base URL" className={field.sized} type="url" value={ollamaBaseUrl}
                    onChange={(event) => {
                      const value = event.target.value
                      setOllamaBaseUrl(value)
                      persist({ ollamaBaseUrl: value.trim() }, { ollamaBaseUrl: value })
                    }} spellCheck={false} />
                  <small className={field.hint}>Use the OpenAI-compatible endpoint, including /v1.</small>
                </label>
              </div>}
            </>}
            {section === 'display' && <>
              <label className={field.wrap}>
                <span className={field.label}>Font size</span>
                <select aria-label="Font size" className={field.sized} value={fontSize} onChange={(event) => {
                  const value = Number(event.target.value)
                  setFontSize(value)
                  persist({ fontSize: value })
                }}>
                  {Array.from({ length: MAX_FONT_SIZE - MIN_FONT_SIZE + 1 }, (_, index) => MIN_FONT_SIZE + index).map((size) => (
                    <option key={size} value={size}>{size} px{size === DEFAULT_FONT_SIZE ? ' (Default)' : ''}</option>
                  ))}
                </select>
                <small className={field.hint}>Scales text and controls across Anvil automatically.</small>
              </label>
              <div className="mb-7 rounded-lg border border-line bg-raised p-5" style={{ fontSize: fontSize * DEFAULT_FONT_SIZE / normalizeFontSize(settings?.fontSize) }} aria-label="Font size preview">
                <p className="font-medium">Your next task starts here.</p>
                <p className="mt-1 text-dim">Add a feature or fix a bug.</p>
              </div>
              {settings && <OverviewBackgroundPicker value={appearance} onChange={(value) => {
                setAppearance(value)
                persist(Object.fromEntries(Object.entries(value).filter(([key, next]) => next !== appearance[key as keyof OverviewAppearance])))
              }} />}
            </>}
          </fieldset>
        </div>
      </main>
    </div>
  )
}
