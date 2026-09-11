import { useRef, useState, type JSX } from 'react'
import type { Task } from '@shared/types'
import { Icon } from '../icons'
import { useStore } from '../state/store'
import { btn, cn, field } from '../ui'

/** The Compact affordance the task view hands down to the bottom bar. */
export interface CompactControl {
  visible: boolean
  busy: boolean
  disabled: boolean
  error: string
  onCompact: () => void
}

export function TaskSteeringComposer({ task, compact }: {
  task: Task
  compact?: CompactControl
}): JSX.Element {
  const supported = useStore((state) => state.agents.find((agent) => agent.id === task.agentId)?.supportsSteering)
  const steerTask = useStore((state) => state.steerTask)
  const cancelTask = useStore((state) => state.cancelTask)
  const [message, setMessage] = useState('')
  const [sending, setSending] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const pending = useRef(false)
  const waitingForTurn = task.status === 'running' && (!supported || !task.sessionId)
  const unavailable = waitingForTurn || ['preparing', 'finalizing', 'did_not_commit'].includes(task.deliveryStatus)
  // With an empty input, the action slot stops a running task instead of sending.
  const stopMode = task.status === 'running' && !message.trim()
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
  const stop = async (): Promise<void> => {
    if (stopping) return
    setStopping(true)
    setError(null)
    try {
      await cancelTask(task.id)
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      setStopping(false)
    }
  }

  return (
    <form
      aria-label="Steer task"
      className="shrink-0 px-5 py-2.5 border-t border-line bg-raised"
      onSubmit={(event) => { event.preventDefault(); void send() }}
    >
      <div className="flex items-stretch gap-2">
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
            if (event.key === 'Enter' && !event.shiftKey && !event.altKey && !event.nativeEvent.isComposing) {
              event.preventDefault()
              void send()
            }
          }}
        />
        {stopMode ? (
          <button
            type="button"
            aria-label="Stop task"
            title="Stop task"
            className={cn(btn.danger, 'grid w-11 shrink-0 place-items-center self-stretch px-0 py-0')}
            disabled={stopping}
            onClick={() => void stop()}
          >
            <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true" focusable="false">
              <rect x="1" y="1" width="12" height="12" fill="currentColor" />
            </svg>
          </button>
        ) : (
          <button
            type="submit"
            aria-label="Send message"
            title="Send message"
            className={cn(btn.primary, 'grid w-11 shrink-0 place-items-center self-stretch px-0 py-0')}
            disabled={sending || unavailable || !message.trim()}
          >
            <Icon icon={sending ? 'loader' : 'chevron-up'} size={16} className={cn(sending && 'animate-spin')} />
          </button>
        )}
      </div>
      {(compact?.visible || task.status === 'running') && (
        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-dim">
          {compact?.visible && (
            <button
              type="button"
              className={cn(btn.ghost, 'px-2 py-0.5 text-[11px]')}
              disabled={compact.disabled}
              title="Summarize earlier model history in this task's session"
              onClick={compact.onCompact}
            >
              {compact.busy ? 'Compacting…' : 'Compact'}
            </button>
          )}
          {task.status === 'running' && <span>{stopMode ? 'The agent is working. Type to steer it, or press the square to stop.' : 'Press Enter to send.'}</span>}
        </div>
      )}
      {compact?.error && <p role="alert" className="mt-1.5 max-h-16 overflow-y-auto text-xs text-danger">{compact.error}</p>}
      {error && <p role="alert" className="mt-1.5 max-h-16 overflow-y-auto text-xs text-danger">{error}</p>}
    </form>
  )
}
