import { useRef, useState, type JSX } from 'react'
import type { Task } from '@shared/types'
import { Icon } from '../icons'
import { useStore } from '../state/store'
import { btn, cn, field } from '../ui'
import { TaskContextControl, type TaskContextControlProps } from './TaskContextControl'

export function TaskSteeringComposer({ task, contextControl }: {
  task: Task
  contextControl?: TaskContextControlProps
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
      {contextControl && <TaskContextControl {...contextControl} />}
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
            className={cn(btn.danger, 'grid h-10 w-14 shrink-0 place-items-center self-center px-0 py-0')}
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
            className={cn(btn.primary, 'grid h-10 w-14 shrink-0 place-items-center self-center px-0 py-0')}
            disabled={sending || unavailable || !message.trim()}
          >
            <Icon icon={sending ? 'loader' : 'chevron-up'} size={16} className={cn(sending && 'animate-spin')} />
          </button>
        )}
      </div>
      {error && <p role="alert" className="mt-1.5 max-h-16 overflow-y-auto text-xs text-danger">{error}</p>}
    </form>
  )
}
