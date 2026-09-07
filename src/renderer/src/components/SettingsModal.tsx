import type { JSX } from 'react'
import { useEffect, useState } from 'react'
import { ProviderModelSelect } from './ProviderModelSelect'
import { GitHubSettings } from './GitHubSettings'
import { acceleratorFromEvent, IS_MAC } from '../keys'
import { useStore } from '../state/store'
import { btn, cn, field, hint, modal } from '../ui'
import { DEFAULT_KEYBINDINGS, formatAccelerator, SHORTCUTS } from '@shared/keybindings'
import type { Keybindings, ShortcutDefinition } from '@shared/keybindings'
import type { RebaseMode } from '@shared/types'

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
          'flex-none min-w-[92px] px-2.5 py-[5px] font-mono text-xs bg-canvas border rounded-md',
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

export function SettingsModal(): JSX.Element {
  const settings = useStore((s) => s.settings)
  const agents = useStore((s) => s.agents)
  const modelsByAgent = useStore((s) => s.modelsByAgent)
  const loadingModelsAgentId = useStore((s) => s.loadingModelsAgentId)
  const loadAgentModels = useStore((s) => s.loadAgentModels)
  const projects = useStore((s) => s.projects)
  const activeProjectId = useStore((s) => s.activeProjectId)
  const saveSettings = useStore((s) => s.saveSettings)
  const updateProject = useStore((s) => s.updateProject)
  const removeProject = useStore((s) => s.removeProject)
  const setSettingsOpen = useStore((s) => s.setSettingsOpen)

  const [defaultAgentId, setDefaultAgentId] = useState(settings?.defaultAgentId ?? 'opencode')
  const [defaultModel, setDefaultModel] = useState(settings?.defaultModel ?? '')
  const [rebaseMode, setRebaseMode] = useState<RebaseMode>(settings?.rebaseMode ?? 'manual')
  const [keybindings, setKeybindings] = useState<Keybindings>(
    settings?.keybindings ?? DEFAULT_KEYBINDINGS
  )
  const [saved, setSaved] = useState(false)

  const activeProject = projects.find((p) => p.id === activeProjectId)
  const [monthlyTokenLimit, setMonthlyTokenLimit] = useState(
    activeProject?.monthlyTokenLimit?.toString() ?? ''
  )
  const [monthlyCostLimitUsd, setMonthlyCostLimitUsd] = useState(
    activeProject?.monthlyCostLimitUsd?.toString() ?? ''
  )
  const [finishOnPush, setFinishOnPush] = useState(activeProject?.finishOnPush ?? false)

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
    await Promise.all([
      saveSettings({ defaultAgentId, defaultModel: defaultModel.trim(), rebaseMode, keybindings }),
      activeProject
        ? updateProject(activeProject.id, {
            monthlyTokenLimit: parseLimit(monthlyTokenLimit),
            monthlyCostLimitUsd: parseLimit(monthlyCostLimitUsd),
            finishOnPush
          })
        : Promise.resolve()
    ])
    setSaved(true)
    setTimeout(() => setSaved(false), 1500)
  }

  return (
    <div className={modal.backdrop} onClick={() => setSettingsOpen(false)}>
      <div
        className={cn(modal.panel, modal.width.normal)}
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className={modal.title}>Settings</h2>

        <label className={field.wrap}>
          <span className={field.label}>Default agent</span>
          <select
            className={field.sized}
            value={defaultAgentId}
            onChange={(e) => setDefaultAgentId(e.target.value)}
          >
            {agents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.label}
              </option>
            ))}
          </select>
        </label>

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

        <GitHubSettings />

        <div className={modal.section}>
          <h3 className="my-3 text-[13px] font-semibold">Keyboard shortcuts</h3>
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
                  onChange={(e) => setMonthlyTokenLimit(e.target.value)}
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
                  onChange={(e) => setMonthlyCostLimitUsd(e.target.value)}
                />
              </label>
            </div>
            <label className={modal.toggle}>
              <input
                className="mt-0.5"
                type="checkbox"
                checked={finishOnPush}
                onChange={(event) => setFinishOnPush(event.target.checked)}
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

        {activeProject && (
          <div className="flex gap-3 items-center justify-between p-3 mt-2 text-xs text-dim border border-line rounded-md">
            <span>
              Remove <strong>{activeProject.name}</strong> and its task history
            </span>
            <button
              className={btn.danger}
              onClick={() => {
                void removeProject(activeProject.id)
                setSettingsOpen(false)
              }}
            >
              Remove
            </button>
          </div>
        )}

        <div className={modal.actions}>
          <span className={hint}>{saved ? 'Saved' : ''}</span>
          <div className="flex gap-2">
            <button className={btn.ghost} onClick={() => setSettingsOpen(false)}>
              Close
            </button>
            <button className={btn.primary} onClick={() => void save()}>
              Save
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
