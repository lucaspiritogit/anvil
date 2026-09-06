import type { JSX } from 'react'
import { useEffect, useState } from 'react'
import { ProviderModelSelect } from './ProviderModelSelect'
import { useStore } from '../state/store'
import { btn, cn, field, hint, modal } from '../ui'

export function NewTaskModal(): JSX.Element {
  const agents = useStore((s) => s.agents)
  const settings = useStore((s) => s.settings)
  const modelsByAgent = useStore((s) => s.modelsByAgent)
  const loadingModelsAgentId = useStore((s) => s.loadingModelsAgentId)
  const loadAgentModels = useStore((s) => s.loadAgentModels)
  const startTask = useStore((s) => s.startTask)
  const setNewTaskOpen = useStore((s) => s.setNewTaskOpen)

  const [agentId, setAgentId] = useState(settings?.defaultAgentId ?? 'opencode')
  const [prompt, setPrompt] = useState('')
  const [model, setModel] = useState('')
  const [busy, setBusy] = useState(false)

  const agent = agents.find((a) => a.id === agentId)
  const catalogue = modelsByAgent[agentId]

  useEffect(() => {
    setModel(agent?.defaultModel ?? '')
  }, [agent])

  useEffect(() => {
    void loadAgentModels(agentId)
  }, [agentId, loadAgentModels])

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
      await startTask({ agentId, prompt: prompt.trim(), model: model.trim() || undefined })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className={modal.backdrop} onClick={() => setNewTaskOpen(false)}>
      <div className={cn(modal.panel, modal.width.normal)} onClick={(e) => e.stopPropagation()}>
        <h2 className={modal.title}>Start new task</h2>

        <label className={field.wrap}>
          <span className={field.label}>Agent</span>
          <select
            className={field.sized}
            value={agentId}
            onChange={(e) => setAgentId(e.target.value)}
          >
            {agents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.label}
              </option>
            ))}
          </select>
        </label>
        {agent && <p className={hint}>{agent.description}</p>}

        <label className={field.wrap}>
          <span className={field.label}>Model</span>
          <ProviderModelSelect
            models={catalogue?.models ?? []}
            value={model}
            onChange={setModel}
            loading={loadingModelsAgentId === agentId && !catalogue}
            error={catalogue?.error}
          />
        </label>

        <label className={field.wrap}>
          <span className={field.label}>Task</span>
          <textarea
            className={field.textarea}
            autoFocus
            rows={7}
            value={prompt}
            placeholder="Describe the work."
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void submit()
            }}
          />
        </label>

        <div className={modal.actions}>
          <span className={hint}>Ctrl+Enter to dispatch</span>
          <div className="flex gap-2">
            <button className={btn.ghost} onClick={() => setNewTaskOpen(false)}>
              Cancel
            </button>
            <button className={btn.primary} disabled={!prompt.trim() || busy} onClick={() => void submit()}>
              {busy ? 'Starting…' : 'Dispatch'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
