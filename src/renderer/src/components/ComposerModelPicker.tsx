import type { JSX, RefObject } from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { HugeiconsIcon } from '@hugeicons/react'
import { AiBrain01Icon, ArrowDown01Icon, Cancel01Icon, Search01Icon, Tick02Icon } from '@hugeicons/core-free-icons'
import { cn, field } from '../ui'
import { PickerDialog } from './PickerDialog'
import type { AgentDefinition, ProviderModelList } from '@shared/types'
import { AgentIcon } from './AgentIcon'
import { ProviderIcon } from './ProviderIcon'

import { describeModel, groupModelsBySubscription, type ModelOption } from '../model-options'

export function ComposerModelPicker({ agents, agentId, modelsByAgent, selectedModels, value, onChange, loadModels }: {
  agents: AgentDefinition[]
  agentId: string
  modelsByAgent: Record<string, ProviderModelList>
  selectedModels: Record<string, string>
  value: string
  onChange: (agentId: string, model: string) => void
  loadModels: (agentId: string) => Promise<void>
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const selected = describeModel(value.trim(), agentId)
  const agent = agents.find((candidate) => candidate.id === agentId)

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-label={selected.name ? `Model: ${selected.name}` : 'Choose a model'}
        aria-description={agent && selected.name ? agent.label : undefined}
        title={selected.name ? `${agent?.label} · ${selected.name} · ${selected.providerName} credentials` : 'Choose a model'}
        disabled={!agents.length}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(true)}
        className="flex min-w-0 max-w-full items-center gap-2 px-2.5 py-1.5 text-xs font-medium hover:bg-hover focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-45"
      >
        {agent && selected.name ? <AgentIcon agentId={agentId} label={agent.label} size={16} />
          : <HugeiconsIcon icon={AiBrain01Icon} size={16} className="shrink-0 text-dim" aria-hidden="true" />}
        <span className="truncate">{selected.name || 'Choose a model'}</span>
        <HugeiconsIcon icon={ArrowDown01Icon} size={12} className="shrink-0 text-dim" aria-hidden="true" />
      </button>
      {open && (
        <ModelPickerDialog
          anchorRef={triggerRef}
          agentId={agentId}
          agents={agents}
          modelsByAgent={modelsByAgent}
          selectedModels={selectedModels}
          loadModels={loadModels}
          onClose={() => setOpen(false)}
          onSelect={(providerId, model) => {
            onChange(providerId, model)
            setOpen(false)
          }}
        />
      )}
    </>
  )
}

function ModelPickerDialog({ anchorRef, agentId, agents, modelsByAgent, selectedModels, loadModels, onClose, onSelect }: {
  anchorRef: RefObject<HTMLButtonElement | null>
  agentId: string
  agents: AgentDefinition[]
  modelsByAgent: Record<string, ProviderModelList>
  selectedModels: Record<string, string>
  loadModels: (agentId: string) => Promise<void>
  onClose: () => void
  onSelect: (agentId: string, model: string) => void
}): JSX.Element {
  const [providerId, setProviderId] = useState(agentId || agents.find((agent) => agent.id === 'codex')?.id || agents[0]?.id || '')
  const searchRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const [query, setQuery] = useState('')
  const [customModel, setCustomModel] = useState(selectedModels[providerId] ?? '')
  const catalogue = modelsByAgent[providerId]
  const loading = Boolean(providerId) && !catalogue
  const error = catalogue?.error
  const value = selectedModels[providerId]?.trim() ?? ''
  const models = catalogue?.models
  const allowCustom = !models?.length && !loading
  const options = useMemo(() => [...new Set(value ? [value, ...(models ?? [])] : models ?? [])]
    .map((model) => describeModel(model, providerId)), [providerId, models, value])
  const selectModel = (model: string): void => onSelect(providerId, model)

  useEffect(() => {
    if (providerId) void loadModels(providerId)
  }, [providerId, loadModels])

  const browseProvider = (id: string): void => {
    setProviderId(id)
    setQuery('')
    setCustomModel(selectedModels[id] ?? '')
    if (listRef.current) listRef.current.scrollTop = 0
  }
  const search = query.trim().toLowerCase()
  const filtered = options.filter((option) =>
    `${option.name} ${option.id} ${option.company} ${option.providerName}`.toLowerCase().includes(search))
  const subscriptionGroups = groupModelsBySubscription(filtered)

  return (
    <PickerDialog anchorRef={anchorRef} label="Choose model" onClose={onClose} wide>
      <div className="flex h-full">
        <nav aria-label="Providers" className="w-36 shrink-0 overflow-y-auto border-r border-line bg-canvas p-2 max-[480px]:w-24"
          onKeyDown={(event) => {
            if (event.key === 'ArrowRight') { event.preventDefault(); searchRef.current?.focus(); return }
            if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return
            const buttons = [...event.currentTarget.querySelectorAll('button')]
            const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
            if (index < 0) return
            event.preventDefault()
            const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
              : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length
            buttons[next]?.focus()
          }}>
          <p className="px-2 pb-3 pt-2 text-[11px] font-medium text-dim">Providers</p>
          {agents.map((agent) => (
            <button key={agent.id} type="button" aria-pressed={providerId === agent.id}
              onClick={() => browseProvider(agent.id)}
              className={cn('mb-1 flex w-full items-center gap-2 px-2 py-3 text-left text-xs hover:bg-hover focus-visible:outline-2 focus-visible:outline-accent', providerId === agent.id && 'bg-hover text-fg')}>
              <AgentIcon agentId={agent.id} label={agent.label} size={16} />
              <span className="truncate">{agent.label}</span>
            </button>
          ))}
        </nav>
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="mx-3 flex items-center gap-2 border-b border-line focus-within:border-accent">
            <HugeiconsIcon icon={Search01Icon} size={16} className="shrink-0 text-dim" aria-hidden="true" />
            <input
              ref={searchRef}
              type="search"
              aria-label="Search models"
              placeholder="Search models…"
              className="min-w-0 flex-1 bg-transparent py-3.5 text-xs outline-none placeholder:text-dim"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'ArrowDown') {
                  event.preventDefault()
                  listRef.current?.querySelector('button')?.focus()
                }
              }}
            />
            <button type="button" aria-label="Close model picker" className="p-1 text-dim hover:bg-hover hover:text-fg focus-visible:outline-accent" onClick={onClose}>
              <HugeiconsIcon icon={Cancel01Icon} size={14} aria-hidden="true" />
            </button>
          </div>
          <div
            ref={listRef}
            role="group"
            aria-label="Models"
            aria-busy={loading}
            className="min-h-0 flex-1 overflow-y-auto p-2"
            onKeyDown={(event) => {
              if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
              const buttons = [...event.currentTarget.querySelectorAll('button')]
              const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
              if (index < 0) return
              event.preventDefault()
              const nextIndex = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
                : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length
              buttons[nextIndex]?.focus()
            }}
          >
            {providerId === 'opencode' ? subscriptionGroups.map((group) => (
              <div key={group.id} role="group" aria-label={group.id === 'other' ? group.title : `${group.title} models`} className="border-t border-line pb-2 first:border-t-0 last:pb-0">
                <h3 className="px-3 pb-2 pt-3 text-[11px] font-medium text-dim">{group.title}</h3>
                {group.models.map((option) => (
                  <ModelRow key={option.id} option={option} selected={option.id === value} onSelect={selectModel} />
                ))}
              </div>
            )) : filtered.map((option) => (
              <ModelRow key={option.id} option={option} selected={option.id === value} onSelect={selectModel} />
            ))}
            {loading && <p role="status" className="px-3 py-4 text-xs text-dim">Loading models…</p>}
            {!loading && !filtered.length && (
              <p role="status" className="px-3 py-6 text-center text-xs text-dim">{search ? 'No models match your search.' : 'No models listed by this agent.'}</p>
            )}
          </div>
          {allowCustom && (
            <div className="border-t border-line px-3 py-2">
              <label className="block text-[11px] text-dim">
                Custom model
                <input
                  className={cn(field.sized, 'mt-1 text-xs')}
                  placeholder="provider/model"
                  value={customModel}
                  onChange={(event) => setCustomModel(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && customModel.trim()) {
                      event.preventDefault()
                      selectModel(customModel.trim())
                    }
                  }}
                />
              </label>
              <button type="button" disabled={!customModel.trim()} className="mt-2 text-xs text-accent disabled:opacity-45" onClick={() => selectModel(customModel.trim())}>Use custom model</button>
            </div>
          )}
          <div className="border-t border-line px-4 py-2 text-[11px] text-dim">
            {error ? <p role="status">Could not list models: {error}</p> : `${filtered.length} ${filtered.length === 1 ? 'model' : 'models'}`}
          </div>
        </div>
      </div>
    </PickerDialog>
  )
}

function ModelRow({ option, selected, onSelect }: {
  option: ModelOption
  selected: boolean
  onSelect: (model: string) => void
}): JSX.Element {
  return (
    <button
      type="button"
      aria-label={option.name}
      aria-description={`Uses ${option.providerName} credentials`}
      aria-pressed={selected}
      title={option.id}
      onClick={() => onSelect(option.id)}
      className={cn('mb-1 flex w-full items-center gap-3 px-3 py-3 text-left hover:bg-hover focus-visible:bg-hover focus-visible:outline-2 focus-visible:outline-accent', selected && 'bg-hover')}
    >
      <ProviderIcon company={option.company} size={16} />
      <span className="min-w-0 flex-1 truncate text-xs font-medium">{option.name}</span>
      {selected && <HugeiconsIcon icon={Tick02Icon} size={16} className="shrink-0 text-accent" aria-hidden="true" />}
    </button>
  )
}
