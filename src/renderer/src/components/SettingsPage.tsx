import { WorkspaceAgentAccounts } from './WorkspaceAgentAccounts'
import type { JSX } from 'react'
import { SETTINGS_SECTIONS } from '../settings-sections'
import { useEffect, useRef, useState } from 'react'
import { ProviderPicker } from './ProviderPicker'
import { ProviderModelSelect } from './ProviderModelSelect'
import { OverviewBackgroundPicker, type OverviewAppearance } from './OverviewBackgroundPicker'
import { GitHubSettings } from './GitHubSettings'
import { acceleratorFromEvent, IS_MAC } from '../keys'
import { useStore } from '../state/store'
import { btn, cn, field, hint, modal } from '../ui'
import { DEFAULT_KEYBINDINGS, formatAccelerator, SHORTCUTS } from '@shared/keybindings'
import type { Keybindings, ShortcutDefinition } from '@shared/keybindings'
import { DEFAULT_FONT_SIZE, MIN_FONT_SIZE, MAX_FONT_SIZE, normalizeFontSize } from '@shared/appearance'
import { DEFAULT_EMBEDDING_MODEL, DEFAULT_OLLAMA_BASE_URL } from '@shared/memory-settings'
import type { RebaseMode, Settings } from '@shared/types'

type ProjectDraft = { monthlyTokenLimit: string; monthlyCostLimitUsd: string; finishOnPush: boolean }

function parseLimit(value: string): number | null {
  const parsed = Number(value)
  return value && Number.isFinite(parsed) && parsed > 0 ? parsed : null
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
  const workspaceId = useStore((s) => s.activeWorkspaceId)
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
  const saveSettings = useStore((s) => s.saveSettings)
  const updateProject = useStore((s) => s.updateProject)
  const removeProject = useStore((s) => s.removeProject)
  const setSettingsOpen = useStore((s) => s.setSettingsOpen)

  const [defaultAgentId, setDefaultAgentId] = useState(settings?.defaultAgentId ?? 'opencode')
  const [defaultModel, setDefaultModel] = useState(settings?.defaultModel ?? '')
  const [confirmRebase, setConfirmRebase] = useState(settings?.confirmRebase ?? true)
  const [rebaseMode, setRebaseMode] = useState<RebaseMode>(settings?.rebaseMode ?? 'manual')
  const caffeineSave = useStore((s) => s.caffeineSave)
  const setCaffeineMode = useStore((s) => s.setCaffeineMode)
  const caffeineMode = caffeineSave?.status === 'pending'
    ? caffeineSave.value
    : settings?.caffeineMode ?? false
  const [keybindings, setKeybindings] = useState<Keybindings>(
    settings?.keybindings ?? DEFAULT_KEYBINDINGS
  )
  const [saved, setSaved] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState('')
  const initialSettings = useRef<Partial<Settings> | null>(null)
  const [appearance, setAppearance] = useState<OverviewAppearance>({
    overviewBackgroundMode: 'color', overviewBackgroundColor: '#0d0f12', overviewWallpaperId: null
  })
  useEffect(() => { initialSettings.current = null }, [workspaceId])
  useEffect(() => {
    if (!settings || initialSettings.current) return
    initialSettings.current = settings
    setAppearance({ overviewBackgroundMode: settings.overviewBackgroundMode,
      overviewBackgroundColor: settings.overviewBackgroundColor, overviewWallpaperId: settings.overviewWallpaperId })
    setMemoryEnabled(settings.memoryEnabled)
    setMemoryEmbeddingModel(settings.memoryEmbeddingModel)
    setOllamaBaseUrl(settings.ollamaBaseUrl)
    setFontSize(settings.fontSize)
    setDefaultAgentId(settings.defaultAgentId)
    setDefaultModel(settings.defaultModel)
    setRebaseMode(settings.rebaseMode)
    setConfirmRebase(settings.confirmRebase)
    setKeybindings(settings.keybindings)
  }, [settings])

  const activeProject = projects.find((p) => p.id === activeProjectId) ?? projects[0]
  const [projectDrafts, setProjectDrafts] = useState<Record<string, ProjectDraft>>({})
  const projectDraft = (activeProject ? projectDrafts[activeProject.id] : undefined) ?? {
    monthlyTokenLimit: activeProject?.monthlyTokenLimit?.toString() ?? '',
    monthlyCostLimitUsd: activeProject?.monthlyCostLimitUsd?.toString() ?? '',
    finishOnPush: activeProject?.finishOnPush ?? false
  }
  const { monthlyTokenLimit, monthlyCostLimitUsd, finishOnPush } = projectDraft
  const updateProjectDraft = (patch: Partial<ProjectDraft>): void => {
    if (activeProject) setProjectDrafts((drafts) => ({ ...drafts, [activeProject.id]: { ...projectDraft, ...patch } }))
  }

  const catalogue = modelsByAgent[defaultAgentId]

  useEffect(() => {
    void loadAgentModels(defaultAgentId)
  }, [defaultAgentId, loadAgentModels])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setSettingsOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [setSettingsOpen])

  const save = async (): Promise<void> => {
    setSaving(true)
    setSaved(false)
    setSaveError('')
    try {
      const draft: Partial<Settings> = {
        memoryEnabled,
        memoryEmbeddingModel: memoryEmbeddingModel.trim(),
        ollamaBaseUrl: ollamaBaseUrl.trim(),
        ...appearance, fontSize, defaultAgentId, defaultModel: defaultModel.trim(),
        rebaseMode, confirmRebase, keybindings
      }
      // Send only edited preferences so immediate writes are preserved.
      const patch = Object.fromEntries(Object.entries(draft).filter(([key, value]) =>
        JSON.stringify(value) !== JSON.stringify(initialSettings.current?.[key as keyof Settings])
      )) as Partial<Settings>
      await Promise.all([
        saveSettings(patch),
        ...Object.entries(projectDrafts).filter(([id]) => projects.some((project) => project.id === id)).map(([id, value]) => updateProject(id, {
          monthlyTokenLimit: parseLimit(value.monthlyTokenLimit),
          monthlyCostLimitUsd: parseLimit(value.monthlyCostLimitUsd),
          finishOnPush: value.finishOnPush
        }))
      ])
      initialSettings.current = draft
      setProjectDrafts((current) => Object.fromEntries(Object.entries(current).filter(([id, value]) => value !== projectDrafts[id])))
      setSaved(true)
      setTimeout(() => setSaved(false), 1500)
    } catch (error) {
      setSaveError(`Could not save settings. ${error instanceof Error ? error.message : 'Try again.'}`)
    } finally {
      setSaving(false)
    }
  }

  const currentSection = SETTINGS_SECTIONS.find((item) => item.id === section)!

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col bg-canvas" data-testid="settings-page">
      <main className="min-h-0 flex-1 overflow-y-auto px-8 py-7 max-[600px]:px-5" aria-labelledby="settings-section-title">
        <div className="mx-auto max-w-[720px]">
          <h2 id="settings-section-title" className="text-2xl font-semibold tracking-tight">{currentSection.label}</h2>
          <p className="mb-7 mt-2 text-sm text-dim">{currentSection.description}</p>
          {!settings && <p role="status" className="mb-4 text-dim">Loading settings…</p>}
          {(section === 'general' || section === 'source-control') && projects.length > 0 && (
            <label className={cn(field.wrap, 'mb-6')}>
              <span className={field.label}>Project</span>
              <select aria-label="Project" className={field.sized} value={activeProject?.id ?? ''} onChange={(event) => selectProject(event.target.value)}>
                {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
              </select>
            </label>
          )}
          <div className="min-w-0">
            {section === 'providers' && <>
              <WorkspaceAgentAccounts />
              <div className={field.wrap}>
                <span className={field.label}>Default agent</span>
                <ProviderPicker agents={agents} value={defaultAgentId} onChange={setDefaultAgentId} label="Default agent" />
              </div>

              <label className={field.wrap}>
                <span className={field.label}>Default model</span>
                <ProviderModelSelect
                  models={catalogue?.models ?? []}
                  value={defaultModel}
                  onChange={setDefaultModel}
                  loading={loadingModelsAgentId === defaultAgentId && !catalogue}
                  error={catalogue?.error}
                />
              </label>

            </>}
            {section === 'general' && <>
              <label className={modal.toggle}>
                <input
                  className="mt-0.5"
                  type="checkbox"
                  checked={caffeineMode}
                  disabled={!settings}
                  aria-describedby="caffeine-save-status"
                  onChange={(event) => void setCaffeineMode(event.target.checked)}
                />
                <span className="block">
                  <strong className="block">Caffeine mode</strong>
                  <small className={field.hint}>Keep the computer and display awake while tasks are running.</small>
                </span>
              </label>

              <div id="caffeine-save-status" className="mb-3 text-xs">
                {caffeineSave?.status === 'error' ? (
                  <div role="alert" className="flex items-center gap-2 text-danger">
                    <span>Could not save Caffeine mode. The last saved setting is shown.</span>
                    <button className={btn.text} onClick={() => void setCaffeineMode(caffeineSave.value)}>
                      Retry
                    </button>
                  </div>
                ) : (
                  <span role="status" className={hint}>
                    {!settings ? 'Loading Caffeine mode…' : caffeineSave ? 'Saving Caffeine mode…' : 'Caffeine mode saves automatically.'}
                  </span>
                )}
              </div>

              {activeProject && (
                <div className={modal.section}>
                  <h3 className="my-3 text-[13px] font-semibold">{activeProject.name} limits</h3>
                  <div className="grid grid-cols-2 gap-3">
                    <label className={field.wrap}>
                      <span className={field.label}>Monthly token limit</span>
                      <input
                        className={field.sized}
                        type="number"
                        min="0"
                        step="1"
                        placeholder="No limit"
                        value={monthlyTokenLimit}
                        onChange={(e) => updateProjectDraft({ monthlyTokenLimit: e.target.value })}
                      />
                    </label>
                    <label className={field.wrap}>
                      <span className={field.label}>Monthly cost limit, USD</span>
                      <input
                        className={field.sized}
                        type="number"
                        min="0"
                        step="0.01"
                        placeholder="No limit"
                        value={monthlyCostLimitUsd}
                        onChange={(e) => updateProjectDraft({ monthlyCostLimitUsd: e.target.value })}
                      />
                    </label>
                  </div>
                </div>
              )}

              {activeProject && (
                <div className="flex gap-3 items-center justify-between p-3 mt-2 text-xs text-dim border border-line">
                  <span>
                    Remove <strong>{activeProject.name}</strong> and its task history
                  </span>
                  <button
                    className={btn.danger}
                    onClick={() => {
                      void removeProject(activeProject.id).then(() => setSettingsOpen(false)).catch((error) => {
                        setSaveError(error instanceof Error ? error.message : 'Could not remove project.')
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
                  onChange={(e) => setRebaseMode(e.target.value as RebaseMode)}
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
                <input type="checkbox" checked={confirmRebase} onChange={(event) => setConfirmRebase(event.target.checked)} />
                <span>Ask before handing a rebase to an agent</span>
              </label>
              <GitHubSettings />
              {activeProject && (
                <div className={modal.section}>
                  <label className={modal.toggle}>
                    <input
                      className="mt-0.5"
                      type="checkbox"
                      checked={finishOnPush}
                      onChange={(event) => updateProjectDraft({ finishOnPush: event.target.checked })}
                    />
                    <span className="block">
                      <strong className="block">Work is done on push</strong>
                      <small className="block mt-1 text-dim leading-[1.4]">
                        Reserve this project preference for automatic GitHub delivery. Automatic delivery is not enabled yet;
                        use Open PR to push and open a pull request manually.
                      </small>
                    </span>
                  </label>
                </div>
              )}
            </div>
            {section === 'shortcuts' && <>
              <p className="mb-4 text-xs text-dim">Select a shortcut, then press the keys you want to use. Escape cancels.</p>
              <div className={modal.section}>
                {SHORTCUTS.map((shortcut) => (
                  <ShortcutField
                    key={shortcut.id}
                    shortcut={shortcut}
                    accelerator={keybindings[shortcut.id]}
                    onChange={(accelerator) =>
                      setKeybindings((current) => ({ ...current, [shortcut.id]: accelerator }))
                    }
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
                <input type="checkbox" checked={memoryEnabled} disabled={!settings} onChange={(event) => setMemoryEnabled(event.target.checked)} />
                <span>
                  <strong className="block">Enable project memory</strong>
                  <small className={field.hint}>Save completed task context and include relevant memories in future tasks. Off by default.</small>
                </span>
              </label>
              {memoryEnabled && <div className="mt-6 space-y-5">
                <label className={field.wrap}>
                  <span className={field.label}>Embedding model</span>
                  <input aria-label="Embedding model" className={field.sized} list="embedding-models" value={memoryEmbeddingModel}
                    onChange={(event) => setMemoryEmbeddingModel(event.target.value)} spellCheck={false} />
                  <datalist id="embedding-models"><option value={DEFAULT_EMBEDDING_MODEL} /></datalist>
                  <small className={field.hint}>Choose or enter an installed Ollama model with 1,024-dimensional embeddings.</small>
                </label>
                <label className={field.wrap}>
                  <span className={field.label}>Ollama base URL</span>
                  <input aria-label="Ollama base URL" className={field.sized} type="url" value={ollamaBaseUrl}
                    onChange={(event) => setOllamaBaseUrl(event.target.value)} spellCheck={false} />
                  <small className={field.hint}>Use the OpenAI-compatible endpoint, including /v1.</small>
                </label>
              </div>}
            </>}
            {section === 'display' && <>
              <label className={field.wrap}>
                <span className={field.label}>Font size</span>
                <select aria-label="Font size" className={field.sized} value={fontSize} onChange={(event) => setFontSize(Number(event.target.value))}>
                  {Array.from({ length: MAX_FONT_SIZE - MIN_FONT_SIZE + 1 }, (_, index) => MIN_FONT_SIZE + index).map((size) => (
                    <option key={size} value={size}>{size} px{size === DEFAULT_FONT_SIZE ? ' (Default)' : ''}</option>
                  ))}
                </select>
                <small className={field.hint}>Scales text and controls across Anvil after saving.</small>
              </label>
              <div className="mb-7 rounded-lg border border-line bg-raised p-5" style={{ fontSize: fontSize * DEFAULT_FONT_SIZE / normalizeFontSize(settings?.fontSize) }} aria-label="Font size preview">
                <p className="font-medium">Your next task starts here.</p>
                <p className="mt-1 text-dim">Add a feature or fix a bug.</p>
              </div>
              {settings && <OverviewBackgroundPicker value={appearance} onChange={setAppearance} />}
            </>}
          </div>
        </div>
      </main>
      <footer className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-t border-line px-8 py-4">
        <div aria-live="polite" className="min-w-0 flex-1 text-xs">
          {saveError ? <p role="alert" className="text-danger">{saveError}</p> : <span className={hint}>{saved ? caffeineSave ? 'Other settings saved' : 'Saved' : 'Changes apply when you save.'}</span>}
        </div>
        <div className="flex gap-2">
          <button className={btn.ghost} onClick={() => setSettingsOpen(false)}>Close</button>
          <button className={btn.primary} disabled={!settings || saving} onClick={() => void save()}>{saving ? 'Saving…' : 'Save'}</button>
        </div>
      </footer>
    </div>
  )
}
