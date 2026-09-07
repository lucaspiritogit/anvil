import type { JSX } from 'react'
import { useEffect, useRef, useState } from 'react'
import { HugeiconsIcon } from '@hugeicons/react'
import { ArrowDown01Icon, ArrowUp01Icon, AiBrain01Icon } from '@hugeicons/core-free-icons'
import { IS_MAC } from '../keys'
import { useStore } from '../state/store'
import { THINKING_LEVELS, useComposerPreferences, type ThinkingLevel } from '../state/composer-preferences'
import { thinkingLevelFromLabel } from '@shared/types'
import { cn } from '../ui'
import { AgentIcon } from './AgentIcon'
import { ComposerModelPicker } from './ComposerModelPicker'
import { ComposerOverflowOptions } from './ComposerOverflowOptions'

const compactSelect = 'min-w-0 field-sizing-content appearance-none rounded-lg bg-transparent py-1.5 pl-2 pr-6 text-xs text-dim outline-none hover:bg-hover hover:text-fg focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-45'

export function TaskComposer(): JSX.Element {
  const agents = useStore((state) => state.agents)
  const modelsByAgent = useStore((state) => state.modelsByAgent)
  const loadingModelsAgentId = useStore((state) => state.loadingModelsAgentId)
  const loadAgentModels = useStore((state) => state.loadAgentModels)
  const startTask = useStore((state) => state.startTask)
  const taskComposerFocusRequest = useStore((state) => state.taskComposerFocusRequest)
  const promptRef = useRef<HTMLTextAreaElement>(null)
  const composerRef = useRef<HTMLFormElement>(null)
  const preferences = useComposerPreferences()
  const agent = agents.find((candidate) => candidate.id === preferences.agentId)
  const agentId = agent?.id ?? ''
  const model = preferences.modelsByAgent[agentId] ?? ''
  const thinkingLevel = preferences.thinkingLevel
  const [prompt, setPrompt] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const submitting = useRef(false)
  const catalogue = modelsByAgent[agentId]
  const usesModelEfforts = agentId === 'opencode'
  const availableEfforts = catalogue?.effortsByModel?.[model] ?? []
  const savedEffort = preferences.effortsByModel[model]
  const preferredEffort = thinkingLevel === 'Off' ? 'minimal' : thinkingLevelFromLabel(thinkingLevel)
  const modelEffort = availableEfforts.includes(savedEffort) ? savedEffort
    : availableEfforts.includes(preferredEffort) ? preferredEffort
      : availableEfforts.includes('default') ? 'default' : availableEfforts[0] ?? ''
  const loadingEfforts = usesModelEfforts && Boolean(model) && !catalogue
  const thinkingOptions = usesModelEfforts
    ? availableEfforts.map((value) => ({ value, label: value.split(/[_-]/).map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(' ') }))
    : THINKING_LEVELS.map((value) => ({ value, label: value }))
  const setModelEffort = preferences.setModelEffort

  // Derive the valid value above so submission never waits for this persistence effect.
  useEffect(() => {
    if (usesModelEfforts && modelEffort && savedEffort !== modelEffort) setModelEffort(model, modelEffort)
  }, [usesModelEfforts, model, modelEffort, savedEffort, setModelEffort])

  useEffect(() => {
    promptRef.current?.focus()
  }, [taskComposerFocusRequest])

  useEffect(() => {
    if (agentId) void loadAgentModels(agentId)
  }, [agentId, loadAgentModels])

  const submit = async (): Promise<void> => {
    if (!prompt.trim() || !agent || !model.trim() || loadingEfforts || submitting.current) return
    submitting.current = true
    setBusy(true)
    setError(null)
    try {
      await startTask({
        agentId,
        prompt: prompt.trim(),
        model: model.trim() || undefined,
        ...(usesModelEfforts
          ? modelEffort ? { modelEffort } : {}
          : { thinkingLevel: thinkingLevelFromLabel(thinkingLevel) })
      })
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
      ref={composerRef}
      aria-label="Start a task"
      className="@container/composer overflow-hidden rounded-2xl border border-line bg-raised shadow-[0_12px_40px_rgba(0,0,0,0.2)] focus-within:border-accent/50 transition-colors"
      onSubmit={(event) => {
        event.preventDefault()
        void submit()
      }}
    >
      <fieldset disabled={busy} className="min-w-0">
        <textarea
          aria-label="Task prompt"
          ref={promptRef}
          rows={3}
          className="block w-full resize-none bg-transparent px-5 pb-3 pt-4 text-sm leading-relaxed outline-none placeholder:text-dim/60"
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
        <div className="flex min-w-0 items-center gap-1 px-3 pb-3 pt-1">
          <ComposerModelPicker
            key={agentId}
            agentId={agentId}
            models={catalogue?.models ?? []}
            value={model}
            onChange={(model) => preferences.setModel(agentId, model)}
            disabled={!agent}
            loading={loadingModelsAgentId === agentId && !catalogue}
            error={catalogue?.error}
          />
          <ComposerOverflowOptions containerRef={composerRef}>
            <label className="relative flex min-w-0 max-w-full items-center rounded-lg">
              <span className="pointer-events-none absolute left-2"><AgentIcon agentId={agentId} label={agent?.label ?? 'Agent'} size={16} /></span>
              <select
                aria-label="Agent"
                title="Agent"
                className={cn(compactSelect, 'max-w-48 pl-8')}
                value={agentId}
                onChange={(event) => preferences.setAgentId(event.target.value)}
              >
                <option className="bg-raised text-fg" value="" disabled>Choose a provider</option>
                {agents.map((availableAgent) => (
                  <option className="bg-raised text-fg" key={availableAgent.id} value={availableAgent.id}>{availableAgent.label}</option>
                ))}
              </select>
              <HugeiconsIcon icon={ArrowDown01Icon} size={12} className="pointer-events-none absolute right-2 text-dim" aria-hidden="true" />
            </label>
            <label className="relative flex items-center rounded-lg" title="Thinking level">
              <HugeiconsIcon icon={AiBrain01Icon} size={16} className="pointer-events-none absolute left-2 text-dim" aria-hidden="true" />
              <select
                aria-label="Thinking level"
                className={cn(compactSelect, 'pl-8')}
                value={usesModelEfforts ? modelEffort : thinkingLevel}
                disabled={loadingEfforts || !thinkingOptions.length}
                onChange={(event) => usesModelEfforts
                  ? setModelEffort(model, event.target.value)
                  : preferences.setThinkingLevel(event.target.value as ThinkingLevel)}
              >
                {!thinkingOptions.length && <option value="">{loadingEfforts ? 'Loading efforts…' : 'Agent default'}</option>}
                {thinkingOptions.map((option) => <option className="bg-raised text-fg" key={option.value} value={option.value}>{option.label}</option>)}
              </select>
              <HugeiconsIcon icon={ArrowDown01Icon} size={12} className="pointer-events-none absolute right-2 text-dim" aria-hidden="true" />
            </label>
          </ComposerOverflowOptions>
          <div className="ml-auto flex shrink-0 items-center gap-3 pl-2">
            <span className="hidden whitespace-nowrap text-[11px] text-dim @min-[640px]/composer:inline">{IS_MAC ? '⌘ Enter' : 'Ctrl+Enter'}</span>
            <button
              type="submit"
              aria-label={busy ? 'Starting…' : 'Send'}
              title={busy ? 'Starting…' : 'Send'}
              className="grid size-8 shrink-0 place-items-center rounded-full bg-accent text-canvas transition-colors hover:bg-accent/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-35"
              disabled={!prompt.trim() || !agent || !model.trim() || loadingEfforts || busy}
            >
              <HugeiconsIcon icon={ArrowUp01Icon} size={18} aria-hidden="true" />
            </button>
          </div>
        </div>
      </fieldset>
      {error && <p role="alert" className="px-5 pb-4 text-xs text-danger">{error}</p>}
    </form>
  )
}
