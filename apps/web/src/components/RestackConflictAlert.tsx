import { Icon } from '../icons'
import { btn } from '../ui'

type RestackConflictAlertProps = {
  error?: string
  disabled: boolean
  onRetry: () => void
  onResolveWithAgent: () => void
}

export function RestackConflictAlert({ error, disabled, onRetry, onResolveWithAgent }: RestackConflictAlertProps) {
  return <div role="alert" className="border border-danger/40 bg-danger/8 p-3 text-sm space-y-2">
    <p className="flex items-center gap-1.5 font-medium text-danger"><Icon icon="merge" size={14} />Restack conflict</p>
    {error && <p className="whitespace-pre-wrap text-dim">{error}</p>}
    <div className="flex gap-2">
      <button className={btn.ghost} disabled={disabled} onClick={onRetry}>Retry restack</button>
      <button className={btn.ghost} disabled={disabled} onClick={onResolveWithAgent}>Resolve with agent</button>
    </div>
  </div>
}
