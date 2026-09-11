import { useStore } from '../state/store'
import { useEffect, useRef, useState } from 'react'
import type { JSX } from 'react'
import type { Settings, Wallpaper } from '@shared/types'
import { loadWallpaper } from '../state/wallpaper-cache'
import { Icon } from '../icons'
import { btn, cn, field, modal } from '../ui'

export type OverviewAppearance = Pick<Settings, 'overviewBackgroundMode' | 'overviewBackgroundColor' | 'overviewWallpaperId'>
const PAGE_SIZE = 3

const MODES = [
  { value: 'color', label: 'Solid color' },
  { value: 'image', label: 'Image' }
] as const

function Thumbnail({ wallpaper, refresh, workspaceId }: { wallpaper: Wallpaper; refresh?: boolean; workspaceId?: string }): JSX.Element {
  const [url, setUrl] = useState<string | null | undefined>(undefined)
  useEffect(() => {
    let cancelled = false
    void loadWallpaper(wallpaper.id, { refresh, workspaceId }).then(
      (entry) => { if (!cancelled) setUrl(entry?.dataUrl ?? null) },
      () => { if (!cancelled) setUrl(null) }
    )
    return () => { cancelled = true }
  }, [wallpaper.id, refresh, workspaceId])
  return url
    ? <img src={url} alt="" className="aspect-[4/3] w-full object-cover" />
    : <span className="flex aspect-[4/3] items-center justify-center text-xs text-dim">{url === undefined ? 'Loading…' : 'Image unavailable.'}</span>
}

export function OverviewBackgroundPicker({ value, onChange }: {
  value: OverviewAppearance
  onChange: (value: OverviewAppearance) => void
}): JSX.Element {
  const workspaceId = useStore((state) => state.activeWorkspaceId) ?? undefined
  const [library, setLibrary] = useState<Wallpaper[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const [revision, setRevision] = useState(0)
  const [page, setPage] = useState(0)
  const [importing, setImporting] = useState(false)
  const [importError, setImportError] = useState<string | null>(null)
  const requestGeneration = useRef(0)
  useEffect(() => {
    setImporting(false)
    setImportError(null)
    return () => { requestGeneration.current += 1 }
  }, [workspaceId])

  const addWallpaper = async (): Promise<void> => {
    const generation = requestGeneration.current
    setImporting(true)
    setImportError(null)
    try {
      const added = await window.anvil.wallpapers.importImage(workspaceId)
      if (!added || generation !== requestGeneration.current) return
      const items = await window.anvil.wallpapers.list(workspaceId)
      if (generation !== requestGeneration.current) return
      setLibrary(items)
      setError(false)
      const index = items.findIndex((item) => item.id === added.id)
      setPage(index < 0 ? 0 : Math.floor(index / PAGE_SIZE))
    } catch (error) {
      if (generation === requestGeneration.current) {
        setImportError(error instanceof Error ? error.message : 'Could not add wallpaper. Try another image.')
      }
    } finally {
      if (generation === requestGeneration.current) setImporting(false)
    }
  }
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(false)
    void window.anvil.wallpapers.list(workspaceId).then((items) => {
      if (cancelled) return
      setLibrary(items)
      setPage(0)
    }, () => { if (!cancelled) setError(true) }).finally(() => {
      if (!cancelled) setLoading(false)
    })
    return () => { cancelled = true }
  }, [revision, workspaceId])
  const pages = Math.ceil(library.length / PAGE_SIZE)
  return (
    <fieldset className={cn(modal.section, 'min-w-0')}>
      <legend className="text-[13px] font-semibold">Overview background</legend>
      <div className="mt-2 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <p className="min-w-0 text-[11px] text-dim">Project preview only · PNG, JPEG or WebP · the color is the fallback.</p>
        <div role="radiogroup" aria-label="Overview background mode" className="inline-flex shrink-0 rounded-full border border-line p-0.5">
          {MODES.map((mode) => {
            const selected = value.overviewBackgroundMode === mode.value
            return (
              <label key={mode.value} className={cn('relative cursor-pointer rounded-full px-3 py-1 text-xs', selected ? 'bg-accent text-canvas' : 'text-dim hover:text-fg')}>
                <input type="radio" name="overview-background-mode" value={mode.value} checked={selected}
                  className="absolute inset-0 cursor-pointer opacity-0"
                  onChange={() => onChange({ ...value, overviewBackgroundMode: mode.value })} />
                {mode.label}
              </label>
            )
          })}
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
        <label className="flex items-center gap-2.5 text-xs text-dim">
          Background color
          <input type="color" value={value.overviewBackgroundColor}
            className="h-6 w-9 cursor-pointer rounded border border-line bg-transparent p-0"
            onChange={(event) => onChange({ ...value, overviewBackgroundColor: event.target.value })} />
        </label>
        <div className="flex items-center gap-2">
          <button type="button" className={btn.ghost} disabled={loading || importing} onClick={() => void addWallpaper()}>
            {importing ? 'Adding image…' : 'Add image…'}
          </button>
          {pages > 1 && <div className="flex items-center">
            <button type="button" aria-label="Previous images" disabled={page === 0}
              className={cn(btn.icon, 'disabled:cursor-not-allowed disabled:opacity-30')}
              onClick={() => setPage(page - 1)}>
              <Icon icon="chevron-left" size={16} />
            </button>
            <span role="status" className="min-w-[3ch] text-center text-[11px] tabular-nums text-dim">{page + 1} / {pages}</span>
            <button type="button" aria-label="Next images" disabled={page + 1 >= pages}
              className={cn(btn.icon, 'disabled:cursor-not-allowed disabled:opacity-30')}
              onClick={() => setPage(page + 1)}>
              <Icon icon="chevron-right" size={16} />
            </button>
          </div>}
        </div>
      </div>

      {importError && <p role="alert" className="mt-2 text-xs text-danger">{importError}</p>}
      {loading ? <p role="status" className={field.hint}>Loading wallpapers…</p> : error ? (
        <div className="mt-2">
          <p role="alert" className="text-xs text-danger">Cannot load wallpapers. Check folder permissions and try again.</p>
          <button type="button" className={cn(btn.ghost, 'mt-2')} disabled={importing} onClick={() => setRevision((current) => current + 1)}>Retry</button>
        </div>
      ) : <>
        {library.length === 0 && <p role="status" className={field.hint}>No wallpapers yet. Choose Add image to get started.</p>}
        {value.overviewWallpaperId && !library.some((item) => item.id === value.overviewWallpaperId) && (
          <p role="status" className={cn(field.hint, 'break-words')}>Selected image {value.overviewWallpaperId} is unavailable. Add it again or choose another image. The background color will be used until it is available.</p>
        )}
        {value.overviewBackgroundMode === 'image' && library.length > 0 && (
          <div className="mt-3 grid min-w-0 grid-cols-3 gap-2" aria-label="Wallpapers">
            {library.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE).map((wallpaper) => {
              const selected = value.overviewWallpaperId === wallpaper.id
              return (
                <button key={`${revision}:${wallpaper.id}`} type="button" aria-pressed={selected}
                  className={cn('relative min-w-0 overflow-hidden border p-1 text-left focus-visible:outline-2 focus-visible:outline-accent', selected ? 'border-accent bg-accent/10' : 'border-line hover:border-dim')}
                  onClick={() => onChange({ ...value, overviewWallpaperId: wallpaper.id })}>
                  <Thumbnail workspaceId={workspaceId} wallpaper={wallpaper} refresh={revision > 0} />
                  <span className="block truncate text-[11px]" title={wallpaper.name}>{wallpaper.name}</span>
                  {selected && <span aria-hidden="true" className="absolute right-1.5 top-1.5 grid size-5 place-items-center rounded-full bg-accent text-canvas"><Icon icon="check" size={12} /></span>}
                </button>
              )
            })}
          </div>
        )}
      </>}
    </fieldset>
  )
}