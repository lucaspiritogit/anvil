import { useRef, useState, type JSX } from 'react'
import type { Task, TaskComment, TaskQueuedPrompt, TaskSteerMode } from '@anvil/protocol/types'
import { useStore } from '../state/store'
import { useModelLabel } from '../state/agent-models'
import { TaskContextControl, type TaskContextControlProps } from './TaskContextControl'
import { StatusGlyph } from './StatusGlyph'

const NOTES_ONLY_MESSAGE = 'Address the notes on the diff.'

function noteLocation(note: TaskComment): string {
  const name = note.file.slice(note.file.lastIndexOf('/') + 1)
  return note.file ? `${name}:${note.lineNumber}` : 'Note'
}

function errorText(failure: unknown): string {
  return failure instanceof Error ? failure.message : String(failure)
}

function QueuedPrompts({ task, running, onError }: {
  task: Task
  running: boolean
  onError: (message: string | null) => void
}): JSX.Element | null {
  const removeQueuedPrompt = useStore((state) => state.removeQueuedPrompt)
  const editQueuedPrompt = useStore((state) => state.editQueuedPrompt)
  const steerQueuedPrompt = useStore((state) => state.steerQueuedPrompt)
  const [openId, setOpenId] = useState<string | null>(null)
  const [draft, setDraft] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const items = task.promptQueue ?? []
  if (!items.length) return null
  const openIndex = items.findIndex((item) => item.id === openId)
  const open: TaskQueuedPrompt | undefined = items[openIndex]
  const act = async (action: () => Promise<void>): Promise<void> => {
    if (busy) return
    setBusy(true)
    onError(null)
    try {
      await action()
      setOpenId(null)
      setDraft(null)
    } catch (failure) {
      onError(errorText(failure))
    } finally {
      setBusy(false)
    }
  }
  const steerNow = (item: TaskQueuedPrompt): Promise<void> => act(() => steerQueuedPrompt(task.id, item.id))
  const remove = (item: TaskQueuedPrompt): Promise<void> => act(() => removeQueuedPrompt(task.id, item.id))
  const save = (item: TaskQueuedPrompt): Promise<void> => {
    const message = draft?.trim()
    if (!message) return Promise.resolve()
    return act(() => editQueuedPrompt(task.id, item.id, message))
  }
  const actionClass = 'inline-flex h-6 items-center gap-1 px-1.5 font-mono text-[11px] text-dim hover:bg-hover hover:text-fg focus-visible:outline-2 focus-visible:outline-accent disabled:text-faint'

  return (
    <section aria-label="Queued messages" className="border-b border-dashed border-line px-3 py-2">
      <ul aria-label="Queued for after this turn" className="flex flex-wrap items-center gap-1.5">
        <li aria-hidden="true" className="font-mono text-[11px] text-dim">Queued for after this turn</li>
        {items.map((item) => <li key={item.id}
          className={`flex max-w-full min-w-0 items-center gap-1 border bg-overlay py-0.5 pr-1 pl-2 text-xs ${item.id === openId ? 'border-accent/60' : 'border-line-strong'}`}>
          <button type="button" aria-label={`Open queued message: ${item.message}`} aria-expanded={item.id === openId}
            title="Read, edit, or steer this message" className="min-w-0 max-w-64 truncate text-left text-soft hover:text-fg"
            onClick={() => { setOpenId(item.id === openId ? null : item.id); setDraft(null) }}>
            {item.message}
          </button>
          {running && <button type="button" aria-label={`Steer now: ${item.message}`} title="Steer now: add it to the running turn"
            className="grid size-5 shrink-0 place-items-center text-dim hover:bg-hover hover:text-fg" disabled={busy} onClick={() => void steerNow(item)}>
            <span aria-hidden="true">↳</span>
          </button>}
          <button type="button" aria-label={`Remove queued message: ${item.message}`} title="Remove from the queue"
            className="grid size-5 shrink-0 place-items-center text-dim hover:bg-hover hover:text-fg" disabled={busy} onClick={() => void remove(item)}>
            <span aria-hidden="true">×</span>
          </button>
        </li>)}
      </ul>
      {open && <div role="group" aria-label="Queued message" className="mt-2 border border-line-strong bg-overlay">
        <div className="flex min-w-0 flex-wrap items-center justify-between gap-2 border-b border-dashed border-line px-2 py-1 font-mono text-[11px] text-dim">
          <span className="min-w-0 truncate">#{openIndex + 1} in the queue · queued at {new Date(open.queuedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
          <span className="flex items-center gap-1">
            {draft === null ? <>
              <button type="button" className={actionClass} disabled={busy} onClick={() => setDraft(open.message)}>edit</button>
              {running && <button type="button" className={actionClass} disabled={busy} onClick={() => void steerNow(open)}>steer now</button>}
              <button type="button" className={actionClass} disabled={busy} onClick={() => void remove(open)}>remove</button>
              <button type="button" aria-label="Close queued message" className={actionClass} onClick={() => setOpenId(null)}>
                <span aria-hidden="true">×</span>
              </button>
            </> : <>
              <button type="button" className={actionClass} disabled={busy} onClick={() => setDraft(null)}>cancel</button>
              <button type="button" className={`${actionClass} enabled:[&:not(:hover)]:text-ember-400`} disabled={busy || !draft.trim()} onClick={() => void save(open)}>save</button>
            </>}
          </span>
        </div>
        {draft === null
          ? <p className="max-h-40 overflow-y-auto px-3 py-2 text-sm whitespace-pre-wrap text-fg">{open.message}</p>
          : <textarea
            aria-label="Edit queued message"
            autoFocus
            className="block max-h-40 min-h-16 w-full resize-none overflow-y-auto bg-transparent px-3 py-2 text-sm text-fg outline-none field-sizing-content"
            value={draft}
            disabled={busy}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
                event.preventDefault()
                void save(open)
              } else if (event.key === 'Escape') {
                event.stopPropagation()
                setDraft(null)
              }
            }}
          />}
      </div>}
    </section>
  )
}

export function TaskSteeringComposer({ task, contextControl, notes = [], onRemoveNote, onSent }: {
  task: Task
  contextControl?: TaskContextControlProps
  notes?: TaskComment[]
  onRemoveNote?: (id: string) => void
  onSent?: () => void
}): JSX.Element {
  const supported = useStore((state) => state.agents.find((agent) => agent.id === task.agentId)?.supportsSteering)
  const steerTask = useStore((state) => state.steerTask)
  const modelLabel = useModelLabel(task.agentId, task.model)
  const cancelTask = useStore((state) => state.cancelTask)
  const [message, setMessage] = useState('')
  const [sending, setSending] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const pending = useRef(false)
  const running = task.status === 'running'
  const canSteer = running && Boolean(supported)
  const unavailable = !running && ['preparing', 'finalizing', 'did_not_commit'].includes(task.deliveryStatus)
  const hasContent = Boolean(message.trim() || notes.length)
  const stopMode = running && !hasContent
  const send = async (queue = false): Promise<void> => {
    if (pending.current || unavailable || !hasContent) return
    pending.current = true
    setSending(true)
    setError(null)
    const mode: TaskSteerMode | undefined = running ? (queue || !canSteer ? 'queue' : 'steer') : undefined
    try {
      await steerTask(task.id, message.trim() || NOTES_ONLY_MESSAGE, mode)
      setMessage('')
      onSent?.()
    } catch (failure) {
      setError(errorText(failure))
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
      setError(errorText(failure))
    } finally {
      setStopping(false)
    }
  }
  const placeholder = notes.length
    ? `Add instructions, or send the ${notes.length === 1 ? 'note' : `${notes.length} notes`} as is…`
    : running ? 'Steer the agent… (Alt+Enter queues)' : 'Follow up…'
  const primaryLabel = running ? (canSteer ? 'steer' : 'queue') : 'send'
  const primaryTitle = running
    ? canSteer ? 'Steer: add to the current turn (Enter)' : 'Queue: send after the current turn (Enter)'
    : 'Send message'

  return (
    <form
      aria-label="Steer task"
      className="shrink-0 px-5 pt-2 pb-5"
      onSubmit={(event) => { event.preventDefault(); void send() }}
    >
      <div className="border border-line-strong bg-raised transition-colors focus-within:border-accent/60">
        <QueuedPrompts task={task} running={running} onError={setError} />
        {notes.length > 0 && <ul aria-label="Notes for the agent" className="flex flex-wrap gap-1.5 border-b border-dashed border-line px-3 py-2">
          {notes.map((note) => <li key={note.id} className="flex max-w-full min-w-0 items-center gap-1.5 border border-line-strong bg-overlay py-0.5 pr-1 pl-2 text-xs" title={note.file ? `${note.file}:${note.lineNumber}\n${note.body}` : note.body}>
            <span className="shrink-0 font-mono text-[11px] text-ember-400">{noteLocation(note)}</span>
            <span className="min-w-0 truncate text-soft">{note.body}</span>
            {onRemoveNote && <button type="button" aria-label={`Remove note: ${note.body}`} className="grid size-5 shrink-0 place-items-center text-dim hover:bg-hover hover:text-fg"
              disabled={sending} onClick={() => onRemoveNote(note.id)}>
              <span aria-hidden="true">×</span>
            </button>}
          </li>)}
        </ul>}
        <textarea
          aria-label="Message to agent"
          className="block max-h-40 min-h-11 w-full min-w-0 resize-none overflow-y-auto bg-transparent px-4 py-[11px] text-sm leading-[22px] text-fg outline-none field-sizing-content placeholder:text-faint disabled:text-faint"
          rows={1}
          value={message}
          disabled={sending || unavailable}
          placeholder={placeholder}
          onChange={(event) => setMessage(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault()
              void send(event.altKey)
            }
          }}
        />
        <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-4 gap-y-1 border-t border-dashed border-line px-3 py-1.5 font-mono text-[11px] text-dim">
          <span className="min-w-0 truncate">{task.agentLabel}{modelLabel && <> · {modelLabel}</>}</span>
          <span className="flex min-w-0 flex-wrap items-center justify-end gap-x-3 gap-y-1">
            {contextControl && <TaskContextControl {...contextControl} />}
            {canSteer && <button
              type="button"
              aria-label="Queue message"
              title="Queue: send after the current turn (Alt+Enter)"
              className="inline-flex h-6 items-center gap-1.5 px-2 text-dim hover:bg-hover hover:text-fg focus-visible:outline-2 focus-visible:outline-accent disabled:text-faint"
              disabled={sending || !hasContent}
              onClick={() => void send(true)}
            >
              <span aria-hidden="true">+</span>
              <span aria-hidden="true">queue</span>
            </button>}
            {stopMode ? (
              <button
                type="button"
                aria-label="Stop task"
                title="Stop task"
                className="inline-flex h-6 items-center gap-1.5 px-2 text-danger-text hover:bg-danger-tint focus-visible:outline-2 focus-visible:outline-accent disabled:text-faint"
                disabled={stopping}
                onClick={() => void stop()}
              >
                <span aria-hidden="true">■</span>
                <span aria-hidden="true">{stopping ? 'stopping…' : 'stop'}</span>
              </button>
            ) : (
              <button
                type="submit"
                aria-label={running ? (canSteer ? 'Steer message' : 'Queue message') : 'Send message'}
                title={primaryTitle}
                className="inline-flex h-6 items-center gap-1.5 px-2 text-dim hover:bg-hover hover:text-fg focus-visible:outline-2 focus-visible:outline-accent enabled:[&:not(:hover)]:text-ember-400 disabled:text-faint"
                disabled={sending || unavailable || !hasContent}
              >
                {sending ? <StatusGlyph glyph="running" /> : <span aria-hidden="true">↵</span>}
                <span aria-hidden="true">{primaryLabel}</span>
              </button>
            )}
          </span>
        </div>
      </div>
      {(error || contextControl?.error) && <p role="alert" className="mt-1.5 max-h-16 overflow-y-auto text-xs text-danger">{error || contextControl?.error}</p>}
    </form>
  )
}
