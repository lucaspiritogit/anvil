import type { JSX } from 'react'
import { useRef, useState } from 'react'
import { Icon } from '../icons'
import type { AgentDefinition } from '@shared/types'
import { AgentIcon } from './AgentIcon'
import { ChoicePickerDialog } from './ChoicePickerDialog'

export function ProviderPicker({ agents, value, onChange, label = 'Agent' }: {
  agents: AgentDefinition[]
  value: string
  onChange: (id: string) => void
  label?: string
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const selected = agents.find((agent) => agent.id === value)
  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-label={label}
        aria-description={selected?.label ?? 'Choose a provider'}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={selected?.label ?? 'Choose a provider'}
        onClick={() => setOpen(true)}
        className="flex min-w-0 max-w-full items-center gap-2 px-2 py-1.5 text-xs text-dim hover:bg-hover hover:text-fg focus-visible:outline-2 focus-visible:outline-accent"
      >
        <AgentIcon agentId={value} label={selected?.label ?? 'Agent'} size={16} />
        <span className="truncate">{selected?.label ?? 'Choose a provider'}</span>
        <Icon icon="chevron-down" size={12} className="shrink-0" aria-hidden="true" />
      </button>
      {open && <ChoicePickerDialog
        anchorRef={triggerRef}
        label={label === 'Agent' ? 'Choose provider' : 'Choose default provider'}
        noun="providers"
        choices={agents.map((agent) => ({ id: agent.id, label: agent.label, icon: <AgentIcon agentId={agent.id} label={agent.label} size={16} /> }))}
        value={value}
        onClose={() => setOpen(false)}
        onSelect={(id) => { onChange(id); setOpen(false) }}
      />}
    </>
  )
}
