export interface WallpaperCacheEntry {
  dataUrl: string
  image: HTMLImageElement
}

export type WallpaperReader = (wallpaperId: string, workspaceId?: string) => Promise<string | null>

interface WallpaperCacheSource {
  read: WallpaperReader
}

const desktopApi = (): WallpaperReader => {
  const anvil = (globalThis as { anvil?: { wallpapers?: { read?: WallpaperReader } } }).anvil
  const read = anvil?.wallpapers?.read
  if (!read) throw new Error('Wallpaper API unavailable')
  return read
}

const defaultSource: WallpaperCacheSource = {
  read: (wallpaperId, workspaceId) => desktopApi()(wallpaperId, workspaceId)
}

const entries = new Map<string, WallpaperCacheEntry>()
const inFlight = new Map<string, Promise<WallpaperCacheEntry | null>>()

let source: WallpaperCacheSource = defaultSource

const decode = (dataUrl: string): Promise<HTMLImageElement | null> =>
  new Promise((resolve) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => resolve(null)
    image.src = dataUrl
  })

/** Module-level cache so decoded wallpapers survive overview unmount/remount. */
export function loadWallpaper(
  wallpaperId: string,
  options: { refresh?: boolean; workspaceId?: string } = {}
): Promise<WallpaperCacheEntry | null> {
  const key = JSON.stringify([options.workspaceId ?? 'default', wallpaperId])
  const cached = entries.get(key)
  if (cached && !options.refresh) return Promise.resolve(cached)
  const pending = inFlight.get(key)
  if (pending && !options.refresh) return pending
  const request = source.read(wallpaperId, options.workspaceId)
    .then(async (dataUrl) => {
      if (!dataUrl) {
        entries.delete(key)
        return null
      }
      if (cached && cached.dataUrl === dataUrl) return cached
      const image = await decode(dataUrl)
      if (!image) return null
      const entry: WallpaperCacheEntry = { dataUrl, image }
      entries.set(key, entry)
      return entry
    })
    .finally(() => {
      if (inFlight.get(key) === request) inFlight.delete(key)
    })
  inFlight.set(key, request)
  return request
}

/** Drop the cached entry so the next load re-reads and re-decodes the wallpaper. */
export function invalidateWallpaper(wallpaperId: string, workspaceId = 'default'): void {
  const key = JSON.stringify([workspaceId, wallpaperId])
  entries.delete(key)
  inFlight.delete(key)
}

/** Test hook: swap the underlying reader. */
export function setWallpaperCacheSource(next: WallpaperReader | null): void {
  source = next ? { read: next } : defaultSource
}
