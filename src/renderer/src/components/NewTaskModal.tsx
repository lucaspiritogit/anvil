import type { JSX } from 'react'
import { useEffect, useState } from 'react'
import { useStore } from '../state/store'

export function NewTaskModal(): JSX.Element {
  const agents = useStore((s) => s.agents)
  const settings = useStore((s) => s.settings)
  const startRun = useStore((s) => s.startRun)
  const setNewTaskOpen = useStore((s) => s.setNewTaskOpen)

  const [agentId, setAgentId] = useState(settings?.defaultAgentId ?? 'opencode')
  const [prompt, setPrompt] = useState('')
  const [model, setModel] = useState('')
  const [busy, setBusy] = useState(false)

  const agent = agents.find((a) => a.id === agentId)

  useEffect(() => {
    setModel(agent?.defaultModel ?? '')
  }, [agent])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setNewTaskOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [setNewTaskOpen])

  const submit = async (): Promise<void> => {
    if (!prompt.trim() || busy) return
    setBusy(true)
    try {
      await startRun({ agentId, prompt: prompt.trim(), model: model.trim() || undefined })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="modal-backdrop" onClick={() => setNewTaskOpen(false)}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Start new task</h2>

        <label className="field">
          <span>Agent</span>
          <select value={agentId} onChange={(e) => setAgentId(e.target.value)}>
            {agents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.label}
              </option>
            ))}
          </select>
        </label>
        {agent && <p className="hint">{agent.description}</p>}

        <label className="field">
          <span>Model</span>
          <input
            value={model}
            placeholder="provider/model (optional)"
            onChange={(e) => setModel(e.target.value)}
          />
        </label>

        <label className="field">
          <span>Task</span>
          <textarea
            autoFocus
            rows={7}
            value={prompt}
            placeholder="Describe the work. The agent runs in the project folder."
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void submit()
            }}
          />
        </label>

        <div className="modal-actions">
          <span className="hint">Ctrl+Enter to dispatch</span>
          <div>
            <button className="ghost-btn" onClick={() => setNewTaskOpen(false)}>
              Cancel
            </button>
            <button className="primary-btn" disabled={!prompt.trim() || busy} onClick={() => void submit()}>
              {busy ? 'Starting…' : 'Dispatch'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
