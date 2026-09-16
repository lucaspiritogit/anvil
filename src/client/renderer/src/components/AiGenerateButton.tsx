import type { JSX } from 'react'
import { useRef, useState } from 'react'
import { Icon } from '../icons'
import { btn, cn } from '../ui'

export function AiGenerateButton({
  noun,
  agentLabel,
  disabled = false,
  generate,
  onGenerated,
  onError,
  onBusyChange
}: {
  noun: string
  agentLabel: string
  disabled?: boolean
  generate: () => Promise<string>
  onGenerated: (draft: string) => void
  onError: (message: string) => void
  onBusyChange?: (busy: boolean) => void
}): JSX.Element {
  const inFlight = useRef(false)
  const [busy, setBusy] = useState(false)

  const run = async (): Promise<void> => {
    if (inFlight.current || disabled) return
    inFlight.current = true
    setBusy(true)
    onBusyChange?.(true)
    try {
      onGenerated(await generate())
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error))
    } finally {
      inFlight.current = false
      setBusy(false)
      onBusyChange?.(false)
    }
  }

  return (
    <button
      type="button"
      className={cn(btn.ghost, 'shrink-0 self-start p-2')}
      aria-label={`Generate ${noun} with ${agentLabel}`}
      title={`Let ${agentLabel} write the ${noun}`}
      disabled={disabled || busy}
      onClick={() => void run()}
    >
      <Icon icon="sparkles" size={18} className={busy ? 'animate-pulse' : ''} />
    </button>
  )
}
