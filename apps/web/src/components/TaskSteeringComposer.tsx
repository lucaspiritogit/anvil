import { useRef, useState, type JSX } from 'react'
import type { Task } from '@anvil/protocol/types'
import { useStore } from '../state/store'
import { TaskContextControl, type TaskContextControlProps } from './TaskContextControl'
import { StatusGlyph } from './StatusGlyph'

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
      className="shrink-0 px-5 pt-2 pb-5"
      onSubmit={(event) => { event.preventDefault(); void send() }}
    >
      <div className="border border-line-strong bg-raised transition-colors focus-within:border-accent/60">
        <textarea
          aria-label="Message to agent"
          className="block max-h-40 min-h-11 w-full min-w-0 resize-none overflow-y-auto bg-transparent px-4 py-[11px] text-sm leading-[22px] text-fg outline-none field-sizing-content placeholder:text-faint disabled:text-faint"
          rows={1}
          value={message}
          disabled={sending || unavailable}
          placeholder={task.status === 'running' ? 'Steer the agent…' : 'Follow up…'}
          onChange={(event) => setMessage(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey && !event.altKey && !event.nativeEvent.isComposing) {
              event.preventDefault()
              void send()
            }
          }}
        />
        <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-4 gap-y-1 border-t border-dashed border-line px-3 py-1.5 font-mono text-[11px] text-dim">
          <span className="min-w-0 truncate">{task.agentLabel}{task.model && <> · {task.model}</>}</span>
          <span className="flex min-w-0 flex-wrap items-center justify-end gap-x-3 gap-y-1">
            {contextControl && <TaskContextControl {...contextControl} />}
            {stopMode ? (
              <button
                type="button"
                aria-label="Stop task"
                title="Stop task"
                className="inline-flex h-6 items-center gap-1.5 px-1.5 text-danger-text hover:bg-danger-tint focus-visible:outline-2 focus-visible:outline-accent disabled:text-faint"
                disabled={stopping}
                onClick={() => void stop()}
              >
                <span aria-hidden="true">■</span>
                <span aria-hidden="true">{stopping ? 'stopping…' : 'stop'}</span>
              </button>
            ) : (
              <button
                type="submit"
                aria-label="Send message"
                title="Send message"
                className="inline-flex h-6 items-center gap-1.5 px-1.5 text-dim hover:bg-hover hover:text-fg focus-visible:outline-2 focus-visible:outline-accent enabled:[&:not(:hover)]:text-ember-400 disabled:text-faint"
                disabled={sending || unavailable || !message.trim()}
              >
                {sending ? <StatusGlyph glyph="running" /> : <span aria-hidden="true">↵</span>}
                <span aria-hidden="true">send</span>
              </button>
            )}
          </span>
        </div>
      </div>
      {(error || contextControl?.error) && <p role="alert" className="mt-1.5 max-h-16 overflow-y-auto text-xs text-danger">{error || contextControl?.error}</p>}
    </form>
  )
}
