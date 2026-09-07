import { useRef, useState, type JSX } from 'react'
import type { Task } from '@shared/types'
import { useStore } from '../state/store'
import { btn, cn, field } from '../ui'

export function TaskSteeringComposer({ task, hidden = false }: { task: Task; hidden?: boolean }): JSX.Element {
  const supported = useStore((state) => state.agents.find((agent) => agent.id === task.agentId)?.supportsSteering)
  const steerTask = useStore((state) => state.steerTask)
  const [message, setMessage] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const pending = useRef(false)
  const waitingForTurn = task.status === 'running' && (!supported || !task.sessionId)
  const unavailable = waitingForTurn || ['preparing', 'finalizing', 'did_not_commit'].includes(task.deliveryStatus)
  const send = async (): Promise<void> => {
    if (pending.current || unavailable || !message.trim()) return
    pending.current = true
    setSending(true)
    setError(null)
    try {
      await steerTask(task.id, message.trim())
      setMessage('')
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      pending.current = false
      setSending(false)
    }
  }

  return (
    <form
      aria-label="Steer task"
      hidden={hidden}
      className="shrink-0 px-5 py-2.5 border-t border-line bg-raised"
      onSubmit={(event) => { event.preventDefault(); void send() }}
    >
      <div className="flex items-end gap-2">
        <textarea
          aria-label="Message to agent"
          className={cn(field.control, 'min-w-0 px-2.5 py-2 resize-none text-[13px] overflow-y-auto disabled:opacity-50')}
          rows={2}
          value={message}
          disabled={sending || unavailable}
          placeholder={task.status === 'running'
            ? !supported ? 'This agent can receive a follow-up after it stops...' : !task.sessionId ? 'Waiting for an agent session...' : 'Steer this task...'
            : task.status === 'pending' || task.status === 'failed' || task.status === 'cancelled' ? 'Help this task continue...' : 'Continue this task...'}
          onChange={(event) => setMessage(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !event.nativeEvent.isComposing) {
              event.preventDefault()
              void send()
            }
          }}
        />
        <button type="submit" className={cn(btn.primary, 'text-xs')} disabled={sending || unavailable || !message.trim()}>
          {sending ? 'Sending...' : 'Send'}
        </button>
      </div>
      {error && <p role="alert" className="mt-1.5 max-h-16 overflow-y-auto text-xs text-danger">{error}</p>}
    </form>
  )
}
