import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import {
  invalidateWallpaper,
  loadWallpaper,
  setWallpaperCacheSource
} from '../src/renderer/src/state/wallpaper-cache'

class FakeImage {
  onload: (() => void) | null = null
  onerror: (() => void) | null = null
}

beforeEach(() => {
  Object.defineProperty(FakeImage.prototype, 'src', {
    set(this: FakeImage) {
      queueMicrotask(() => this.onload?.())
    },
    configurable: true
  })
  vi.stubGlobal('Image', FakeImage as unknown as typeof Image)
})

afterEach(() => {
  setWallpaperCacheSource(null)
  vi.unstubAllGlobals()
})

test('caches by wallpaper id and skips repeat reads', async () => {
  let reads = 0
  setWallpaperCacheSource(() => {
    reads += 1
    return Promise.resolve('data:image/png;base64,AAA')
  })
  invalidateWallpaper('w1')
  const first = await loadWallpaper('w1')
  expect(first?.dataUrl).toBe('data:image/png;base64,AAA')
  const second = await loadWallpaper('w1')
  expect(second?.dataUrl).toBe('data:image/png;base64,AAA')
  expect(second?.image).toBe(first?.image)
  expect(reads).toBe(1)
})

test('dedupes concurrent in-flight requests', async () => {
  let reads = 0
  setWallpaperCacheSource(() => {
    reads += 1
    return Promise.resolve('data:image/png;base64,BBB')
  })
  invalidateWallpaper('w2')
  const [first, second] = await Promise.all([loadWallpaper('w2'), loadWallpaper('w2')])
  expect(first?.image).toBe(second?.image)
  expect(reads).toBe(1)
})

test('invalidate forces a fresh read', async () => {
  let reads = 0
  setWallpaperCacheSource(() => {
    reads += 1
    return Promise.resolve('data:image/png;base64,CCC')
  })
  invalidateWallpaper('w3')
  await loadWallpaper('w3')
  invalidateWallpaper('w3')
  const again = await loadWallpaper('w3')
  expect(again?.dataUrl).toBe('data:image/png;base64,CCC')
  expect(reads).toBe(2)
})

test('refresh picks up changed bytes', async () => {
  let bytes = 'data:image/png;base64,OLD'
  setWallpaperCacheSource(() => Promise.resolve(bytes))
  invalidateWallpaper('w4')
  await loadWallpaper('w4')
  bytes = 'data:image/png;base64,NEW'
  const refreshed = await loadWallpaper('w4', { refresh: true })
  expect(refreshed?.dataUrl).toBe('data:image/png;base64,NEW')
  expect((await loadWallpaper('w4'))?.dataUrl).toBe('data:image/png;base64,NEW')
})

test('returns null and does not cache missing wallpapers', async () => {
  let reads = 0
  setWallpaperCacheSource(() => {
    reads += 1
    return Promise.resolve(null)
  })
  invalidateWallpaper('w5')
  await expect(loadWallpaper('w5')).resolves.toBeNull()
  await expect(loadWallpaper('w5')).resolves.toBeNull()
  expect(reads).toBe(2)
})
