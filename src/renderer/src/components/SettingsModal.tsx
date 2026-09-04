import type { JSX } from 'react'
import { useEffect, useState } from 'react'
import { useStore } from '../state/store'
import type { RebaseMode } from '@shared/types'

function parseLimit(value: string): number | null {
  const parsed = Number(value)
  return value && Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

export function SettingsModal(): JSX.Element {
  const settings = useStore((s) => s.settings)
  const agents = useStore((s) => s.agents)
  const projects = useStore((s) => s.projects)
  const activeProjectId = useStore((s) => s.activeProjectId)
  const saveSettings = useStore((s) => s.saveSettings)
  const updateProject = useStore((s) => s.updateProject)
  const removeProject = useStore((s) => s.removeProject)
  const setSettingsOpen = useStore((s) => s.setSettingsOpen)

  const [defaultAgentId, setDefaultAgentId] = useState(settings?.defaultAgentId ?? 'opencode')
  const [defaultModel, setDefaultModel] = useState(settings?.defaultModel ?? '')
  const [rebaseMode, setRebaseMode] = useState<RebaseMode>(settings?.rebaseMode ?? 'manual')
  const [saved, setSaved] = useState(false)

  const activeProject = projects.find((p) => p.id === activeProjectId)
  const [monthlyTokenLimit, setMonthlyTokenLimit] = useState(
    activeProject?.monthlyTokenLimit?.toString() ?? ''
  )
  const [monthlyCostLimitUsd, setMonthlyCostLimitUsd] = useState(
    activeProject?.monthlyCostLimitUsd?.toString() ?? ''
  )
  const [finishOnPush, setFinishOnPush] = useState(activeProject?.finishOnPush ?? false)

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setSettingsOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [setSettingsOpen])

  const save = async (): Promise<void> => {
    await Promise.all([
      saveSettings({ defaultAgentId, defaultModel: defaultModel.trim(), rebaseMode }),
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
    <div className="modal-backdrop" onClick={() => setSettingsOpen(false)}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Settings</h2>

        <label className="field">
          <span>Default agent</span>
          <select value={defaultAgentId} onChange={(e) => setDefaultAgentId(e.target.value)}>
            {agents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.label}
              </option>
            ))}
          </select>
        </label>

        <label className="field">
          <span>Default model</span>
          <input value={defaultModel} onChange={(e) => setDefaultModel(e.target.value)} />
        </label>

        <label className="field">
          <span>Rebase mode</span>
          <select
            value={rebaseMode}
            onChange={(e) => setRebaseMode(e.target.value as RebaseMode)}
          >
            <option value="manual">Manual — choose what happens to each commit</option>
            <option value="agent">Agent — let the agent rewrite the history</option>
          </select>
          <small className="field-hint">
            {rebaseMode === 'manual'
              ? 'Rebase opens a small interactive editor and Anvil performs the rebase.'
              : 'Rebase hands the branch to the agent that wrote the code and accepts its result.'}
          </small>
        </label>

        {activeProject && (
          <div className="settings-section">
            <h3>{activeProject.name} limits</h3>
            <div className="field-row">
              <label className="field">
                <span>Monthly token limit</span>
                <input
                  type="number"
                  min="0"
                  step="1"
                  placeholder="No limit"
                  value={monthlyTokenLimit}
                  onChange={(e) => setMonthlyTokenLimit(e.target.value)}
                />
              </label>
              <label className="field">
                <span>Monthly cost limit, USD</span>
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  placeholder="No limit"
                  value={monthlyCostLimitUsd}
                  onChange={(e) => setMonthlyCostLimitUsd(e.target.value)}
                />
              </label>
            </div>
            <label className="toggle-field">
              <input
                type="checkbox"
                checked={finishOnPush}
                onChange={(event) => setFinishOnPush(event.target.checked)}
              />
              <span>
                <strong>Work is done on push</strong>
                <small>
                  Use {activeProject.gitPlatform} delivery after a successful task. This setting is
                  saved now; remote push and pull requests are not enabled yet.
                </small>
              </span>
            </label>
          </div>
        )}

        {activeProject && (
          <div className="danger-zone">
            <span>
              Remove <strong>{activeProject.name}</strong> and its task history
            </span>
            <button
              className="danger-btn"
              onClick={() => {
                void removeProject(activeProject.id)
                setSettingsOpen(false)
              }}
            >
              Remove
            </button>
          </div>
        )}

        <div className="modal-actions">
          <span className="hint">{saved ? 'Saved' : ''}</span>
          <div>
            <button className="ghost-btn" onClick={() => setSettingsOpen(false)}>
              Close
            </button>
            <button className="primary-btn" onClick={() => void save()}>
              Save
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
