import type { JSX } from 'react'
import { useEffect, useRef, useState } from 'react'
import { HugeiconsIcon } from '@hugeicons/react'
import { ArrowUp01Icon } from '@hugeicons/core-free-icons'
import type { Project } from '@shared/types'
import { IS_MAC } from '../keys'
import { useStore } from '../state/store'
import { btn, cn, field } from '../ui'
import { ProviderModelSelect } from './ProviderModelSelect'

export function TaskComposer({ project }: { project: Project }): JSX.Element {
  const agents = useStore((state) => state.agents)
  const settings = useStore((state) => state.settings)
  const modelsByAgent = useStore((state) => state.modelsByAgent)
  const loadingModelsAgentId = useStore((state) => state.loadingModelsAgentId)
  const loadAgentModels = useStore((state) => state.loadAgentModels)
  const startTask = useStore((state) => state.startTask)
  const taskComposerFocusRequest = useStore((state) => state.taskComposerFocusRequest)
  const promptRef = useRef<HTMLTextAreaElement>(null)
  const [agentId, setAgentId] = useState(settings?.defaultAgentId ?? agents[0]?.id ?? '')
  const agent = agents.find((candidate) => candidate.id === agentId)
  const [model, setModel] = useState(agent?.defaultModel ?? '')
  const [prompt, setPrompt] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const submitting = useRef(false)
  const catalogue = modelsByAgent[agentId]

  useEffect(() => {
    promptRef.current?.focus()
  }, [taskComposerFocusRequest])

  useEffect(() => {
    if (agentId) void loadAgentModels(agentId)
  }, [agentId, loadAgentModels])

  const submit = async (): Promise<void> => {
    if (!prompt.trim() || !agent || submitting.current) return
    submitting.current = true
    setBusy(true)
    setError(null)
    try {
      await startTask({ agentId, prompt: prompt.trim(), model: model.trim() || undefined })
      setPrompt('')
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error))
    } finally {
      submitting.current = false
      setBusy(false)
    }
  }

  return (
    <form
      aria-label="Start a task"
      className="overflow-hidden rounded-2xl border border-line bg-raised shadow-[0_12px_40px_rgba(0,0,0,0.2)] focus-within:border-accent/50 transition-colors"
      onSubmit={(event) => {
        event.preventDefault()
        void submit()
      }}
    >
      <fieldset disabled={busy} className="min-w-0">
        <label htmlFor="overview-task-prompt" className="block px-5 pt-4 text-xs font-medium text-dim">
          New task in {project.name}
        </label>
        <textarea
          id="overview-task-prompt"
          ref={promptRef}
          rows={3}
          className="block w-full resize-none bg-transparent px-5 py-3 text-sm leading-relaxed outline-none placeholder:text-dim/60"
          placeholder="Describe the work you want done…"
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !event.nativeEvent.isComposing) {
              event.preventDefault()
              if (!event.repeat) void submit()
            }
          }}
        />
        <div className="flex flex-wrap items-end gap-3 border-t border-line/60 px-4 py-3">
          <label className="min-w-0 flex-1 basis-[130px]">
            <span className={field.label}>Agent</span>
            <select
              className={cn(field.sized, 'text-xs')}
              value={agentId}
              onChange={(event) => {
                const nextAgentId = event.target.value
                setAgentId(nextAgentId)
                setModel(agents.find((candidate) => candidate.id === nextAgentId)?.defaultModel ?? '')
              }}
            >
              {agents.map((availableAgent) => (
                <option key={availableAgent.id} value={availableAgent.id}>{availableAgent.label}</option>
              ))}
            </select>
          </label>
          <label className="min-w-0 flex-1 basis-[180px] text-xs">
            <span className={field.label}>Model</span>
            <ProviderModelSelect
              models={catalogue?.models ?? []}
              value={model}
              onChange={setModel}
              loading={loadingModelsAgentId === agentId && !catalogue}
              error={catalogue?.error}
            />
          </label>
          <div className="ml-auto flex items-center gap-3 pb-0.5">
            <span className="text-[11px] text-dim">{IS_MAC ? '⌘ Enter' : 'Ctrl+Enter'}</span>
            <button
              type="submit"
              className={cn(btn.primary, 'flex items-center gap-2 rounded-lg')}
              disabled={!prompt.trim() || !agent || busy}
            >
              {busy ? 'Starting…' : 'Send'}
              <HugeiconsIcon icon={ArrowUp01Icon} size={16} aria-hidden="true" />
            </button>
          </div>
        </div>
      </fieldset>
      {error && <p role="alert" className="px-5 pb-4 text-xs text-danger">{error}</p>}
    </form>
  )
}
