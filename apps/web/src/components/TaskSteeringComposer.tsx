import { useRef, useState, type JSX } from 'react'
import type { Task } from '@anvil/protocol/types'
import { useStore } from '../state/store'
import { btn, cn } from '../ui'
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
      className="shrink-0 px-5 pt-2 pb-4"
      onSubmit={(event) => { event.preventDefault(); void send() }}
    >
      {contextControl && <TaskContextControl {...contextControl} />}
      <div className="border border-line-strong bg-raised transition-colors focus-within:border-accent/60">
        <textarea
          aria-label="Message to agent"
          className="block w-full min-w-0 resize-none overflow-y-auto bg-transparent px-4 py-3 text-sm leading-relaxed text-fg outline-none placeholder:text-faint disabled:text-faint"
          rows={2}
          value={message}
          disabled={sending || unavailable}
          placeholder={'Follow up'}
          onChange={(event) => setMessage(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey && !event.altKey && !event.nativeEvent.isComposing) {
              event.preventDefault()
              void send()
            }
          }}
        />
        <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-1.5 border-t border-dashed border-line px-3 py-2 font-mono text-[11px] text-dim">
          <span className="min-w-0 truncate">{task.agentLabel}{task.model && <> · {task.model}</>}</span>
          <span className="flex shrink-0 items-center gap-3">
            {!stopMode && <span aria-hidden="true" className="max-[480px]:hidden">↵ send · ⇧↵ newline</span>}
            {stopMode ? (
              <button
                type="button"
                aria-label="Stop task"
                title="Stop task"
                className={cn(btn.danger, 'flex h-8 shrink-0 items-center gap-2 px-3 py-0 font-sans text-xs font-medium')}
                disabled={stopping}
                onClick={() => void stop()}
              >
                <svg width="10" height="10" viewBox="0 0 14 14" aria-hidden="true" focusable="false">
                  <rect x="1" y="1" width="12" height="12" fill="currentColor" />
                </svg>
                <span aria-hidden="true">Stop</span>
              </button>
            ) : (
              <button
                type="submit"
                aria-label="Send message"
                title="Send message"
                className={cn(btn.primary, 'flex h-8 shrink-0 items-center gap-2 px-3 py-0 font-sans text-xs')}
                disabled={sending || unavailable || !message.trim()}
              >
                {sending ? <StatusGlyph glyph="running" /> : <span aria-hidden="true">Send</span>}
                <span aria-hidden="true" className="bg-canvas/20 px-1 font-mono text-[11px] font-medium">↵</span>
              </button>
            )}
          </span>
        </div>
      </div>
      {error && <p role="alert" className="mt-1.5 max-h-16 overflow-y-auto text-xs text-danger">{error}</p>}
    </form>
  )
}
