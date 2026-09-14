import type { JSX, KeyboardEvent as ReactKeyboardEvent, RefObject } from 'react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import fuzzysort from 'fuzzysort'
import { Icon, type IconName } from '../icons'
import { useAgentModels } from '../state/agent-models'
import { useComposerPreferences } from '../state/composer-preferences'
import { useStore } from '../state/store'
import { cn } from '../ui'
import { ModelPickerDialog } from './ComposerModelPicker'
import { PickerDialog } from './PickerDialog'
import type { ModelReasoningCapabilities, ProviderModelList } from '@shared/types'

type NestedPicker = 'model' | 'thinking' | 'project' | null

export interface CommandPaletteProps {
  open: boolean
  onClose: () => void
  onOpenTerminal: () => void
}

interface Choice {
  id: string
  label: string
  description?: string
}

interface Command {
  id: string
  icon: IconName
  label: string
  description?: string
  disabled?: boolean
  unavailable?: boolean
  pressed?: boolean
  ref?: RefObject<HTMLButtonElement | null>
  onClick: () => void
}

const commandClass = 'flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-hover focus-visible:bg-hover focus-visible:outline-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-45'

export function CommandPalette({ open, onClose, onOpenTerminal }: CommandPaletteProps): JSX.Element {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const restoreFocusRef = useRef<HTMLElement | null>(null)
  const modelRef = useRef<HTMLButtonElement>(null)
  const thinkingRef = useRef<HTMLButtonElement>(null)
  const projectRef = useRef<HTMLButtonElement>(null)
  const [nestedPicker, setNestedPicker] = useState<NestedPicker>(null)
  const [query, setQuery] = useState('')
  const [activeCommand, setActiveCommand] = useState<string | null>('new-task')

  const agents = useStore((state) => state.agents)
  const projects = useStore((state) => state.projects)
  const activeProjectId = useStore((state) => state.activeProjectId)
  const selectProject = useStore((state) => state.selectProject)
  const focusTaskComposer = useStore((state) => state.focusTaskComposer)
  const settings = useStore((state) => state.settings)
  const caffeineSave = useStore((state) => state.caffeineSave)
  const setCaffeineMode = useStore((state) => state.setCaffeineMode)
  const preferences = useComposerPreferences()
  const agentId = preferences.agentId || agents.find((agent) => agent.id === 'codex')?.id || agents[0]?.id || ''
  const model = preferences.modelsByAgent[agentId]?.trim() ?? ''
  const catalogue = useAgentModels(agentId)
  const capabilities = model ? catalogue?.reasoningByModel?.[model] : undefined
  const reasoningOptions = capabilities?.options ?? []
  const savedEffort = preferences.reasoningByAgentModel[JSON.stringify([agentId, model])]
  const reasoningEffort = reasoningOptions.find((option) => option.id === savedEffort)?.id
    ?? reasoningOptions.find((option) => option.id === capabilities?.default)?.id
    ?? reasoningOptions[0]?.id
  const activeProject = projects.find((project) => project.id === activeProjectId)
  const caffeineMode = caffeineSave?.status === 'pending' ? caffeineSave.value : settings?.caffeineMode ?? false
  const caffeinePending = caffeineSave?.status === 'pending'

  const commands: Command[] = [
    { id: 'new-task', icon: 'pencil', label: 'New task', onClick: () => { close(); focusTaskComposer() } },
    { id: 'change-model', ref: modelRef, icon: 'brain-circuit', label: 'Change model',
      description: preferences.saveError ?? undefined, disabled: !agents.length,
      onClick: () => setNestedPicker('model') },
    { id: 'change-thinking', ref: thinkingRef, icon: 'sparkles', label: 'Change thinking',
      description: reasoningEffort ? reasoningOptions.find((option) => option.id === reasoningEffort)?.label : undefined,
      onClick: () => setNestedPicker('thinking') },
    { id: 'change-project', ref: projectRef, icon: 'folder', label: 'Change project',
      description: activeProject?.name, onClick: () => setNestedPicker('project') },
    { id: 'open-terminal', icon: 'terminal', label: 'Open terminal', disabled: !activeProject,
      description: activeProject ? activeProject.name : 'No active project',
      onClick: () => { close(); onOpenTerminal() } },
    { id: 'toggle-caffeine', icon: 'coffee', label: 'Toggle caffeine mode', disabled: !settings,
      unavailable: caffeinePending, pressed: caffeineMode,
      description: caffeinePending ? `Saving ${caffeineMode ? 'on' : 'off'}…`
        : caffeineSave?.status === 'error' ? 'Could not save · Press Enter to retry'
          : caffeineMode ? 'On' : 'Off',
      onClick: toggleCaffeine }
  ]
  const visibleCommands = rankCommands(commands, query)
  const firstEnabledCommand = visibleCommands.find((command) => !command.disabled)
  const selectedCommand = visibleCommands.find((command) => command.id === activeCommand && !command.disabled)
    ?? firstEnabledCommand

  useLayoutEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    if (open) {
      restoreFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
      dialog.showModal()
      setQuery('')
      setActiveCommand('new-task')
      searchRef.current?.focus()
    } else if (dialog.open) {
      dialog.close()
    }
    return () => {
      if (dialog.open) dialog.close()
    }
  }, [open])

  useEffect(() => {
    if (open) return
    setNestedPicker(null)
    setQuery('')
    const previous = restoreFocusRef.current
    restoreFocusRef.current = null
    if (previous?.isConnected) previous.focus()
  }, [open])

  function close(): void {
    setNestedPicker(null)
    onClose()
  }
  const moveCommandFocus = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return
    const commands = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button[data-command]:not(:disabled)')]
    if (!commands.length) return
    event.preventDefault()
    const current = commands.indexOf(document.activeElement as HTMLButtonElement)
    const index = event.key === 'Home' ? 0 : event.key === 'End' ? commands.length - 1
      : current < 0 ? 0 : (current + (event.key === 'ArrowDown' ? 1 : -1) + commands.length) % commands.length
    const next = commands[index]
    if (next) setActiveCommand(next.dataset.commandId ?? null)
    next?.focus()
  }
  function toggleCaffeine(): void {
    if (!settings || caffeinePending) return
    const value = caffeineSave?.status === 'error' ? caffeineSave.value : !caffeineMode
    void setCaffeineMode(value)
  }

  return (
    <>
      <dialog
        ref={dialogRef}
        aria-label="Command palette"
        className="m-auto w-[min(460px,calc(100vw-24px))] max-w-none overflow-hidden border border-line bg-raised p-0 text-fg shadow-[0_16px_64px_rgba(0,0,0,0.5)] backdrop:bg-black/35"
        onCancel={(event) => { event.preventDefault(); close() }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            event.stopPropagation()
            close()
          } else if (event.key === 'Tab') {
            event.preventDefault()
            event.currentTarget.querySelector<HTMLButtonElement>('button[data-command][tabindex="0"]:not(:disabled)')?.focus()
          }
        }}
        onClick={(event) => {
          if (event.target !== event.currentTarget) return
          const bounds = event.currentTarget.getBoundingClientRect()
          if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) close()
        }}
      >
        <header className="border-b border-line px-4 py-3">
          <h2 className="text-sm font-semibold">Command palette</h2>
          <p className="mt-0.5 text-[11px] text-dim">Use arrow keys to navigate · Esc to close</p>
          <input ref={searchRef} type="search" autoFocus aria-label="Search commands" aria-controls="command-palette-commands"
            value={query} placeholder="Search commands…"
            onChange={(event) => {
              const nextQuery = event.currentTarget.value
              setQuery(nextQuery)
              setActiveCommand(rankCommands(commands, nextQuery).find((command) => !command.disabled)?.id ?? null)
            }}
            onKeyDown={(event) => {
              if (!['ArrowUp', 'ArrowDown'].includes(event.key)) return
              const enabled = [...dialogRef.current?.querySelectorAll<HTMLButtonElement>('button[data-command]:not(:disabled)') ?? []]
              const next = event.key === 'ArrowDown' ? enabled[0] : enabled.at(-1)
              if (!next) return
              event.preventDefault()
              setActiveCommand(next.dataset.commandId ?? null)
              next.focus()
            }}
            className="mt-3 w-full border border-line bg-canvas px-3 py-2 text-sm text-fg outline-none placeholder:text-dim focus:border-accent" />
        </header>
        <div id="command-palette-commands">
          {visibleCommands.length ? (
            <div role="menu" aria-label="Commands" className="p-2" onKeyDown={moveCommandFocus}>
              {visibleCommands.map((command) => (
                <CommandButton key={command.id} {...command} active={selectedCommand?.id === command.id} onFocus={setActiveCommand} />
              ))}
            </div>
          ) : (
            <p role="status" className="px-3 py-6 text-center text-sm text-dim">No commands found.</p>
          )}
        </div>
      </dialog>

      {open && nestedPicker === 'model' && (
        <ModelPickerDialog
          anchorRef={modelRef}
          agentId={agentId}
          agents={agents}
          selectedModels={preferences.modelsByAgent}
          onClose={() => setNestedPicker(null)}
          onSelect={(providerId, selectedModel) => {
            preferences.setSelection(providerId, selectedModel)
            setNestedPicker(null)
          }}
        />
      )}
      {open && nestedPicker === 'thinking' && (
        <ChoicePickerDialog
          anchorRef={thinkingRef}
          label="Choose thinking"
          choices={reasoningOptions}
          selectedId={reasoningEffort}
          status={thinkingStatus(agentId, model, catalogue, capabilities)}
          onClose={() => setNestedPicker(null)}
          onSelect={(effort) => {
            preferences.setReasoningEffort(agentId, model, effort)
            setNestedPicker(null)
          }}
        />
      )}
      {open && nestedPicker === 'project' && (
        <ChoicePickerDialog
          anchorRef={projectRef}
          label="Choose project"
          choices={projects.map((project) => ({ id: project.id, label: project.name, description: project.path }))}
          selectedId={activeProjectId ?? undefined}
          status={projects.length ? undefined : 'No projects available.'}
          onClose={() => setNestedPicker(null)}
          onSelect={(projectId) => {
            selectProject(projectId)
            setNestedPicker(null)
          }}
        />
      )}
    </>
  )
}

function rankCommands(commands: Command[], query: string): Command[] {
  if (!query.trim()) return commands
  return fuzzysort.go(query, commands, {
    keys: ['label', 'description'],
    scoreFn: (result) => Math.max(result[0]?.score ?? 0, (result[1]?.score ?? 0) * 0.8)
  }).map((result) => result.obj)
}

function CommandButton({ ref, id, active, icon, label, description, disabled, unavailable, pressed, onFocus, onClick }: Command & {
  ref?: RefObject<HTMLButtonElement | null>
  active: boolean
  onFocus: (id: string) => void
}): JSX.Element {
  return (
    <button ref={ref} id={`command-palette-${id}`} data-command data-command-id={id} type="button" role="menuitem" disabled={disabled}
      tabIndex={active && !disabled ? 0 : -1} onFocus={() => onFocus(id)}
      aria-disabled={disabled || unavailable || undefined}
      aria-pressed={pressed} onClick={onClick} className={commandClass}>
      <Icon icon={icon} size={17} className="shrink-0 text-dim" aria-hidden="true" />
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium">{label}</span>
        {description && <span className="block truncate text-[11px] text-dim">{description}</span>}
      </span>
      <Icon icon="chevron-right" size={14} className="shrink-0 text-dim" aria-hidden="true" />
    </button>
  )
}

function ChoicePickerDialog({ anchorRef, label, choices, selectedId, status, onClose, onSelect }: {
  anchorRef: RefObject<HTMLButtonElement | null>
  label: string
  choices: Choice[]
  selectedId?: string
  status?: string
  onClose: () => void
  onSelect: (id: string) => void
}): JSX.Element {
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const selected = listRef.current?.querySelector<HTMLButtonElement>('button[aria-pressed="true"]')
    const first = listRef.current?.querySelector<HTMLButtonElement>('button')
    ;(selected ?? first)?.focus()
  }, [])

  return (
    <PickerDialog anchorRef={anchorRef} label={label} onClose={onClose}>
      <div className="flex h-full flex-col">
        <header className="flex items-center gap-2 border-b border-line px-3 py-2">
          <button type="button" aria-label="Back to command palette" onClick={onClose}
            className="p-2 text-dim hover:bg-hover hover:text-fg focus-visible:outline-2 focus-visible:outline-accent">
            <Icon icon="chevron-left" size={16} aria-hidden="true" />
          </button>
          <h2 className="text-sm font-semibold">{label}</h2>
        </header>
        <div ref={listRef} role="group" aria-label={label} className="min-h-0 flex-1 overflow-y-auto p-2"
          onKeyDown={(event) => {
            if (event.key === 'ArrowLeft') { event.preventDefault(); onClose(); return }
            if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return
            const choices = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button')]
            if (!choices.length) return
            event.preventDefault()
            const current = choices.indexOf(document.activeElement as HTMLButtonElement)
            const index = event.key === 'Home' ? 0 : event.key === 'End' ? choices.length - 1
              : current < 0 ? 0 : (current + (event.key === 'ArrowDown' ? 1 : -1) + choices.length) % choices.length
            choices[index]?.focus()
          }}>
          {choices.map((choice) => (
            <button key={choice.id} type="button" aria-pressed={choice.id === selectedId}
              title={choice.description} onClick={() => onSelect(choice.id)}
              className={cn(commandClass, choice.id === selectedId && 'bg-hover text-accent')}>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">{choice.label}</span>
                {choice.description && <span className="block truncate text-[11px] text-dim">{choice.description}</span>}
              </span>
              {choice.id === selectedId && <Icon icon="check" size={15} className="shrink-0" aria-hidden="true" />}
            </button>
          ))}
          {status && <p role="status" className="px-3 py-5 text-center text-xs text-dim">{status}</p>}
        </div>
      </div>
    </PickerDialog>
  )
}

function thinkingStatus(
  agentId: string,
  model: string,
  catalogue: ProviderModelList | undefined,
  capabilities: ModelReasoningCapabilities | undefined
): string | undefined {
  if (!agentId) return 'No model provider is available.'
  if (!model) return 'Choose a model before changing thinking.'
  if (!catalogue) return 'Loading thinking options…'
  if (catalogue.error) return `Thinking options unavailable: ${catalogue.error}`
  if (!capabilities) return 'Thinking options are unavailable for this model.'
  if (!capabilities.options.length) return 'This model has no thinking options.'
  return undefined
}
