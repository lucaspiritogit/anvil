import { UnresolvedFile, type FileContents } from '@pierre/diffs'
import type { JSX } from 'react'
import { useEffect, useRef, useState } from 'react'
import type { Task, TaskMergeConflict, TaskMergeConflictFile } from '@shared/types'
import { useStore } from '../state/store'
import { btn, cn, field } from '../ui'

const ICON_BUTTON = 'grid size-7 shrink-0 place-items-center text-dim hover:bg-hover hover:text-fg disabled:opacity-35 disabled:hover:bg-transparent disabled:hover:text-dim'

const UNSUPPORTED_REASON: Record<Extract<TaskMergeConflictFile, { support: 'unsupported' }>['reason'], string> = {
  missing: 'The conflicted file is missing from the checkout.',
  binary: 'Binary files cannot be resolved in the text conflict editor.',
  oversized: 'This file is too large for the conflict editor.',
  symlink: 'Symlinks cannot be resolved in the text conflict editor.',
  submodule: 'Submodule conflicts must be resolved with Git tooling.',
  other: 'This conflict type is not supported by the text editor.',
  unsafe_path: 'This path is not safe to edit from Anvil.',
  unsupported_status: 'This Git conflict status is not supported by the text editor.'
}

function PierreConflictFile({ file, disabled, onResolve }: {
  file: Extract<TaskMergeConflictFile, { support: 'text' }>
  disabled: boolean
  onResolve: (file: FileContents) => void
}): JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)
  const resolveRef = useRef(onResolve)
  resolveRef.current = onResolve

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const unresolved = new UnresolvedFile({
      themeType: 'dark',
      overflow: 'wrap',
      disableFileHeader: true,
      mergeConflictActionsType: 'default',
      onMergeConflictResolve: (resolved) => resolveRef.current(resolved)
    })
    unresolved.render({
      fileContainer: host,
      file: { name: file.path, contents: file.contents, cacheKey: file.contentsHash }
    })
    return () => unresolved.cleanUp()
  }, [file.contents, file.contentsHash, file.path])

  return <div aria-busy={disabled} className={cn('min-w-0', disabled && 'pointer-events-none opacity-60')} ref={hostRef} />
}

export function TaskMergeConflictOutput({ task, conflict, visible }: {
  task: Task
  conflict: TaskMergeConflict
  visible: boolean
}): JSX.Element {
  const state = useStore((store) => store.mergeConflictState?.taskId === task.id && store.mergeConflictState.conflictId === conflict.id
    ? store.mergeConflictState
    : null)
  const load = useStore((store) => store.loadMergeConflict)
  const save = useStore((store) => store.saveMergeConflict)
  const complete = useStore((store) => store.completeMergeConflict)
  const fix = useStore((store) => store.fixMergeConflictWithAgent)
  const abort = useStore((store) => store.abortMergeConflict)
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const snapshot = state?.snapshot
  const files = snapshot?.files ?? []
  const selectedIndex = Math.max(0, files.findIndex((file) => file.path === selectedPath))
  const selectedFile = files[selectedIndex]
  const busy = Boolean(state?.savingPath || state?.action)
  const resolvedCount = Math.max(0, conflict.conflictedFiles.length - files.length)

  useEffect(() => {
    void load(task.id, conflict.id)
  }, [conflict.id, load, task.id])

  useEffect(() => {
    if (!selectedFile) setSelectedPath(null)
    else if (selectedPath !== selectedFile.path) setSelectedPath(selectedFile.path)
  }, [selectedFile, selectedPath])

  const selectFile = (path: string): void => setSelectedPath(path)

  return (
    <section
      id="task-panel-output"
      aria-label="Output"
      className={cn('flex flex-1 min-h-0 min-w-0 flex-col', !visible && 'hidden')}
    >
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line px-4 py-2.5">
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-medium text-warn">Merge conflicts with <code className="font-mono text-fg">{conflict.targetBranch}</code></h2>
          <p role="status" aria-live="polite" className="mt-0.5 text-xs text-dim">
            {snapshot
              ? snapshot.canComplete
                ? 'All conflicted paths are resolved. Complete the merge to finish delivery.'
                : `${resolvedCount} of ${conflict.conflictedFiles.length} resolved · ${files.length} remaining`
              : state?.loading ? 'Loading conflicted files…' : 'Conflict details are unavailable.'}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2 @max-[760px]:w-full">
          <button className={btn.ghost} disabled={busy || state?.loading} onClick={() => void load(task.id, conflict.id)}>
            Refresh conflicts
          </button>
          {!snapshot?.canComplete && <button className={cn(btn.primary, 'inline-flex items-center gap-1.5')} disabled={busy || state?.loading || files.length === 0} onClick={() => void fix(task.id, conflict.id)}>
            {state?.action === 'fix' ? 'Fixing with agent…' : 'Fix with agent'}
          </button>}
          {snapshot?.canComplete && <button autoFocus className={cn(btn.primary, 'bg-ok')} disabled={busy || state?.loading} onClick={() => void complete(task.id, conflict.id)}>
            {state?.action === 'complete' ? 'Completing merge…' : 'Complete merge'}
          </button>}
          <button
            className={btn.danger}
            disabled={busy || state?.loading}
            title="Abort the merge and discard every saved conflict resolution"
            onClick={() => void abort(task.id, conflict.id)}
          >
            {state?.action === 'abort' ? 'Aborting merge…' : 'Abort merge'}
          </button>
        </div>
      </div>

      {state?.error && <div role="alert" className="shrink-0 border-b border-line bg-danger/8 px-4 py-2 text-xs text-danger">
        {state.error}
        <button className={cn(btn.ghost, 'ml-3 py-1')} disabled={busy || state.loading} onClick={() => void load(task.id, conflict.id)}>Retry</button>
      </div>}

      {!snapshot && <div className="grid flex-1 place-content-center gap-3 p-6 text-center text-sm text-dim" aria-busy={state?.loading ?? true}>
        <p>{state?.loading ? 'Loading the live conflict state…' : 'Could not load the live conflict state.'}</p>
        {!state?.loading && <button className={btn.ghost} onClick={() => void load(task.id, conflict.id)}>Retry conflicts</button>}
      </div>}

      {snapshot && !snapshot.canComplete && selectedFile && <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-line px-4 py-2 text-xs">
          <div className="flex min-w-0 flex-1 items-center gap-1 @max-[760px]:basis-full">
            <button className={ICON_BUTTON} aria-label="Previous conflicted file" disabled={busy || selectedIndex === 0} onClick={() => selectFile(files[selectedIndex - 1].path)}>←</button>
            <select
              aria-label="Conflicted file"
              className={cn(field.control, 'min-w-0 flex-1 max-w-xl px-2 py-1 font-mono text-xs')}
              value={selectedFile.path}
              disabled={busy}
              onChange={(event) => selectFile(event.target.value)}
            >
              {files.map((file) => <option key={file.path} value={file.path}>{file.support === 'text' ? '' : 'Unsupported · '}{file.path}</option>)}
            </select>
            <button className={ICON_BUTTON} aria-label="Next conflicted file" disabled={busy || selectedIndex === files.length - 1} onClick={() => selectFile(files[selectedIndex + 1].path)}>→</button>
            <span className="ml-1 shrink-0 tabular-nums text-dim">{selectedIndex + 1} / {files.length}</span>
          </div>
          <span className={selectedFile.support === 'text' ? 'text-dim' : 'text-warn'}>
            {selectedFile.support === 'text' ? 'Choose Current, Incoming, or Both for each conflict.' : 'Requires external Git tooling or Fix with agent.'}
          </span>
        </div>
        <div className="min-h-0 min-w-0 flex-1 overflow-auto overscroll-contain">
          {selectedFile.support === 'text'
            ? <PierreConflictFile
              key={`${conflict.id}:${selectedFile.path}:${selectedFile.contentsHash}:${state.revision}`}
              file={selectedFile}
              disabled={busy}
              onResolve={(resolved) => void save(task.id, conflict.id, selectedFile.path, resolved.contents, selectedFile.contentsHash)}
            />
            : <div className="grid min-h-full place-content-center gap-2 p-6 text-center">
              <p className="text-sm font-medium text-warn">This file cannot be edited here.</p>
              <p className="max-w-lg text-xs text-dim">{UNSUPPORTED_REASON[selectedFile.reason]}</p>
              <code className="font-mono text-xs text-fg">{selectedFile.path}</code>
            </div>}
        </div>
      </div>}

      {snapshot?.canComplete && <div className="grid flex-1 place-content-center gap-2 p-6 text-center">
        <p className="text-sm font-medium text-ok">No unresolved paths remain.</p>
        <p className="text-xs text-dim">Git has staged the resolved files. Complete the paused merge when you are ready.</p>
      </div>}

      <p className="shrink-0 border-t border-line px-4 py-2 text-[11px] text-dim">
        Abort merge discards every resolution saved during this paused merge and returns the task to review.
      </p>
    </section>
  )
}
