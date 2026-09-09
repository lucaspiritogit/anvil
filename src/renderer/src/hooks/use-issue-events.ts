import { useEffect, useState } from 'react'
import type { TaskEvent } from '@shared/types'
import { mergeIssueEvents } from '../state/issue-events'

export function useIssueEvents(taskId: string, issueId?: string) {
  const [state, setState] = useState<{ key: string; events?: TaskEvent[]; error?: string }>({ key: '' })
  const [attempt, setAttempt] = useState(0)
  const key = JSON.stringify([taskId, issueId])
  useEffect(() => {
    if (!issueId) return
    let active = true
    let saved: TaskEvent[] | undefined
    let live: TaskEvent[] = []
    setState({ key })
    const off = window.anvil.tasks.onEvent((event) => {
      if (!active || event.taskId !== taskId || event.issueId !== issueId) return
      live = mergeIssueEvents(taskId, issueId, live, [event])
      setState({ key, events: mergeIssueEvents(taskId, issueId, saved ?? [], live) })
    })
    void window.anvil.tasks.events(taskId).then((events) => {
      if (!active) return
      saved = events
      setState({ key, events: mergeIssueEvents(taskId, issueId, saved, live) })
    }).catch((error: unknown) => {
      if (active) setState({ key, events: live, error: error instanceof Error ? error.message : String(error) })
    })
    return () => { active = false; off() }
  }, [taskId, issueId, key, attempt])
  return { ...(state.key === key ? state : { events: undefined, error: undefined }), retry: () => setAttempt((value) => value + 1) }
}
