import type { JSX } from 'react'
import { useEffect, useRef } from 'react'
import type { ProjectFileList } from '@shared/types'
import { cn } from '../ui'

interface Props {
  id: string
  paths: string[]
  selected: number
  loading: boolean
  result: ProjectFileList | null
  onChoose(path: string): void
  onRetry(): void
}

export function ComposerFilePicker({ id, paths, selected, loading, result, onChoose, onRetry }: Props): JSX.Element {
  const list = useRef<HTMLUListElement>(null)
  useEffect(() => {
    list.current?.children[selected]?.scrollIntoView({ block: 'nearest' })
  }, [selected])
  return (
    <div className="mx-5 mb-3 border border-line bg-raised text-xs" aria-label="Project file finder">
      <div className="flex items-center justify-between border-b border-line px-3 py-2 text-dim">
        <span>Project files · ↑↓ choose · Enter insert · Esc dismiss</span>
        <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={onRetry} className="ml-3 hover:text-fg">Refresh</button>
      </div>
      {loading && <p role="status" className="p-3 text-dim">Loading project files…</p>}
      {!loading && result?.error && <p role="alert" className="p-3 text-danger">{result.error.message}</p>}
      {!loading && !result?.error && paths.length === 0 && <p role="status" className="p-3 text-dim">No matching files.</p>}
      {!loading && (result?.truncated || Boolean(result?.warnings.length)) && <p role="status" className="px-3 py-2 text-dim">Some project files could not be listed. Refresh to try again.</p>}
      <ul id={id} role="listbox" aria-label="Project files" ref={list} className="max-h-52 overflow-y-auto">
        {!loading && paths.map((path, index) => (
          <li key={path} id={`${id}-${index}`} role="option" aria-selected={index === selected}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => onChoose(path)}
            className={cn('cursor-pointer break-all px-3 py-2 font-mono hover:bg-hover', index === selected && 'bg-hover text-accent')}
          >{path}</li>
        ))}
      </ul>
    </div>
  )
}
