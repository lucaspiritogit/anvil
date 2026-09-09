import { useEffect, useState } from 'react'
import type { JSX } from 'react'
import type { Settings, Wallpaper } from '@shared/types'
import { loadWallpaper } from '../state/wallpaper-cache'
import { btn, cn, field, modal } from '../ui'

export type OverviewAppearance = Pick<Settings, 'overviewBackgroundMode' | 'overviewBackgroundColor' | 'overviewWallpaperId'>
const PAGE_SIZE = 3

function Thumbnail({ wallpaper, refresh }: { wallpaper: Wallpaper; refresh?: boolean }): JSX.Element {
  const [url, setUrl] = useState<string | null | undefined>(undefined)
  useEffect(() => {
    let cancelled = false
    void loadWallpaper(wallpaper.id, refresh ? { refresh: true } : {}).then(
      (entry) => { if (!cancelled) setUrl(entry?.dataUrl ?? null) },
      () => { if (!cancelled) setUrl(null) }
    )
    return () => { cancelled = true }
  }, [wallpaper.id, refresh])
  return url
    ? <img src={url} alt="" className="h-16 w-full object-cover" />
    : <span className="flex h-16 items-center justify-center text-xs text-dim">{url === undefined ? 'Loading…' : 'Unavailable. Refresh to retry.'}</span>
}

export function OverviewBackgroundPicker({ value, onChange }: {
  value: OverviewAppearance
  onChange: (value: OverviewAppearance) => void
}): JSX.Element {
  const [library, setLibrary] = useState<Wallpaper[]>([])
  const [directory, setDirectory] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const [revision, setRevision] = useState(0)
  const [page, setPage] = useState(0)
  useEffect(() => {
    let cancelled = false
    void window.anvil.wallpapers.directory().then((path) => {
      if (!cancelled) setDirectory(path)
    }, () => { if (!cancelled) setDirectory(null) })
    return () => { cancelled = true }
  }, [])
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(false)
    void window.anvil.wallpapers.list().then((items) => {
      if (cancelled) return
      setLibrary(items)
      setPage(0)
    }, () => { if (!cancelled) setError(true) }).finally(() => {
      if (!cancelled) setLoading(false)
    })
    return () => { cancelled = true }
  }, [revision])
  const pages = Math.ceil(library.length / PAGE_SIZE)
  return (
    <fieldset className={cn(modal.section, 'min-w-0')}>
      <legend className="text-[13px] font-semibold">Overview background</legend>
      <p className={field.hint}>Applies to the project preview only. The sidebar keeps its current background.</p>
      <div className="my-3 flex gap-4">
        {(['color', 'image'] as const).map((mode) => (
          <label key={mode} className="flex items-center gap-2">
            <input type="radio" name="overview-background-mode" value={mode}
              checked={value.overviewBackgroundMode === mode}
              onChange={() => onChange({ ...value, overviewBackgroundMode: mode })} />
            {mode === 'image' ? 'Image' : 'Solid color'}
          </label>
        ))}
      </div>
      <label className="flex items-center gap-3">
        <span className={field.label}>Background color</span>
        <input type="color" value={value.overviewBackgroundColor}
          onChange={(event) => onChange({ ...value, overviewBackgroundColor: event.target.value })} />
      </label>
      <p className={field.hint}>This color is also used when an image is unavailable.</p>
      <p className={cn(field.hint, 'break-all')}>{directory
        ? <>Drop PNG, JPEG or WebP images into <code>{directory}</code>, then select Refresh.</>
        : 'Wallpaper folder location is unavailable. Reopen Settings to retry.'}</p>
      <button type="button" className={btn.ghost} disabled={loading} onClick={() => setRevision((current) => current + 1)}>Refresh</button>
      {loading ? <p role="status">Loading wallpapers…</p> : error ? (
        <p role="alert">Cannot read the wallpaper folder. Check folder permissions, then Refresh to retry.</p>
      ) : <>
        {library.length === 0 && <p role="status">No supported images found. Add images to the folder, then Refresh.</p>}
        {value.overviewWallpaperId && !library.some((item) => item.id === value.overviewWallpaperId) && (
          <p role="status" className="break-words">Selected image {value.overviewWallpaperId} is unavailable. Restore it and Refresh, or choose another image. The background color will be used until it is available.</p>
        )}
        {value.overviewBackgroundMode === 'image' && library.length > 0 && <>
          <div className="my-3 grid min-w-0 grid-cols-3 gap-2" aria-label="Wallpapers">
            {library.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE).map((wallpaper) => (
              <button key={`${revision}:${wallpaper.id}`} type="button" aria-pressed={value.overviewWallpaperId === wallpaper.id}
                className={cn('min-w-0 overflow-hidden border p-1 text-left focus-visible:outline-2 focus-visible:outline-accent', value.overviewWallpaperId === wallpaper.id ? 'border-accent bg-accent/10' : 'border-line')}
                onClick={() => onChange({ ...value, overviewWallpaperId: wallpaper.id })}>
                <Thumbnail wallpaper={wallpaper} refresh={revision > 0} />
                <span className="block truncate text-xs" title={wallpaper.name}>{wallpaper.name}</span>
                {value.overviewWallpaperId === wallpaper.id && <span className="text-xs text-accent">Selected</span>}
              </button>
            ))}
          </div>
          <div className="flex items-center justify-between gap-2">
            <button type="button" className={btn.ghost} disabled={page === 0} onClick={() => setPage(page - 1)}>Previous images</button>
            <span role="status" className="text-xs">{page + 1} / {pages}</span>
            <button type="button" className={btn.ghost} disabled={page + 1 >= pages} onClick={() => setPage(page + 1)}>Next images</button>
          </div>
        </>}
      </>}
    </fieldset>
  )
}
