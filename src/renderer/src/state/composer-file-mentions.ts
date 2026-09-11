import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent, RefObject } from 'react'
import type { ProjectFileList } from '@shared/types'
import { activeFileMention, fileReference, rankFiles, selectedFilePaths } from '../components/composer-file-mentions'

export function useComposerFileMentions(projectId: string | null, prompt: string, setPrompt: (text: string) => void, textarea: RefObject<HTMLTextAreaElement | null>, retained?: { chosen: string[]; setChosen: (paths: string[]) => void }) {
  const id = useId()
  const pendingCaret = useRef<number | null>(null)
  useLayoutEffect(() => {
    if (pendingCaret.current === null) return
    textarea.current?.focus()
    textarea.current?.setSelectionRange(pendingCaret.current, pendingCaret.current)
    pendingCaret.current = null
  }, [prompt, textarea])
  const [selection, setSelection] = useState([0, 0])
  const [dismissed, setDismissed] = useState('')
  const [composing, setComposing] = useState(false)
  const [localChosen, setLocalChosen] = useState<string[]>([])
  const chosen = retained?.chosen ?? localChosen
  const setChosen = retained?.setChosen ?? setLocalChosen
  const [result, setResult] = useState<ProjectFileList | null>(null)
  const [loading, setLoading] = useState(false)
  const [revision, setRevision] = useState(0)
  const [selected, setSelected] = useState(0)
  const mention = activeFileMention(prompt, selection[0], selection[1])
  const signature = JSON.stringify([prompt, ...selection])
  const open = Boolean(projectId && mention && signature !== dismissed && !composing)
  const paths = useMemo(() => rankFiles(result?.paths ?? [], mention?.query ?? ''), [result, mention?.query])
  useEffect(() => { setSelected(0) }, [mention?.query, result])
  useEffect(() => {
    if (!open || !projectId) return
    let cancelled = false
    setLoading(true)
    setResult(null)
    window.anvil.projects.files({ projectId }).then((value) => {
      if (cancelled) return
      if (value.projectId !== projectId) throw new Error('Project changed. Refresh to try again.')
      setResult(value)
    }).catch((error: unknown) => {
      if (!cancelled) setResult({ projectId, paths: [], source: null, truncated: false, warnings: [], error: {
        code: 'unavailable', message: error instanceof Error ? error.message : String(error)
      } })
    }).finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [open, projectId, revision])

  const syncSelection = (): void => {
    const element = textarea.current
    if (element) setSelection([element.selectionStart, element.selectionEnd])
  }
  const choose = (path: string): void => {
    if (!mention || !open || loading) return
    const token = fileReference(path)
    const text = prompt.slice(0, mention.start) + token + ' ' + prompt.slice(mention.end)
    const caret = mention.start + token.length + 1
    setChosen([...new Set([...selectedFilePaths(prompt, chosen), path])])
    pendingCaret.current = caret
    setPrompt(text)
    setSelection([caret, caret])
  }
  return {
    id, open, paths, selected, loading, result, choose, syncSelection, setComposing,
    references: selectedFilePaths(prompt, chosen),
    retry: () => { setRevision((value) => value + 1); textarea.current?.focus() },
    dismiss: () => setDismissed(signature),
    reset: () => { setChosen([]); setSelection([0, 0]) },
    onKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>): boolean => {
      if (event.nativeEvent.isComposing || composing || event.keyCode === 229) {
        // IME confirmation must neither select a file nor submit the draft.
        event.stopPropagation()
        return true
      }
      if (!open) return false
      if (!['ArrowDown', 'ArrowUp', 'Enter', 'Escape'].includes(event.key)) return false
      event.preventDefault()
      event.stopPropagation()
      if (event.key === 'Escape') setDismissed(signature)
      else if (event.key === 'Enter') { if (!event.repeat && paths[selected]) choose(paths[selected]) }
      else setSelected((value) => paths.length ? (value + (event.key === 'ArrowDown' ? 1 : -1) + paths.length) % paths.length : 0)
      return true
    }
  }
}
