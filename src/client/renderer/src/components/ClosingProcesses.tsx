import type { JSX } from 'react'
import './ClosingProcesses.css'

export function ClosingProcesses(): JSX.Element {
  return (
    <div className="closing-processes" role="status" aria-live="polite">
      <div className="closing-processes-spinner" aria-hidden="true" />
      <span>closing up processes...</span>
    </div>
  )
}
