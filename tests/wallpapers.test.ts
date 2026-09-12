import { onTestCleanup } from './test-cleanup'
import { test, expect } from 'vitest'
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { imageFixture, pngWithDimensions } from './image-fixtures'
import { WallpaperLibrary, MAX_WALLPAPER_BYTES, MAX_WALLPAPER_DIMENSION, MAX_WALLPAPER_PIXELS } from '../src/server/wallpapers'

async function setupWallpapers() {
  const root = await mkdtemp(join(tmpdir(), 'anvil-wallpapers-'))
  onTestCleanup(() => rm(root, { recursive: true, force: true }))
  const config = join(root, 'config')
  const folder = join(config, 'wallpaper')
  const library = new WallpaperLibrary(config)
  await library.list()
  for (const [name, sample] of [['z.png', 'sample.png'], ['A.jpeg', 'sample.jpeg'], ['space name.webp', 'sample.webp']]) {
    await writeFile(join(folder, name), imageFixture(sample))
  }
  const gif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64')
  await writeFile(join(folder, 'unsupported.gif'), gif)
  await writeFile(join(folder, 'disguised.png'), gif)
  await writeFile(join(folder, 'corrupt.png'), 'not an image')
  const png = imageFixture()
  await writeFile(join(folder, 'truncated.png'), png.subarray(0, png.length - 20))
  await mkdir(join(folder, 'directory.png'))
  const outside = join(root, 'outside.png')
  await writeFile(outside, png)
  await symlink(outside, join(folder, 'escape.png'))
  await symlink(join(folder, 'z.png'), join(folder, 'internal-link.png'))
  await writeFile(join(folder, 'large.png'), png)
  await truncate(join(folder, 'large.png'), MAX_WALLPAPER_BYTES + 1)
  await writeFile(join(folder, 'wide.png'), pngWithDimensions(MAX_WALLPAPER_DIMENSION + 1, 1))
  await writeFile(join(folder, 'pixels.png'), pngWithDimensions(4096, Math.floor(MAX_WALLPAPER_PIXELS / 4096) + 1))
  return { root, folder, library, outside }
}

test('creates an empty singular wallpaper folder', async () => {
  const root = await mkdtemp(join(tmpdir(), 'anvil-wallpapers-'))
  onTestCleanup(() => rm(root, { recursive: true, force: true }))
  expect(await new WallpaperLibrary(root).list(), 'Creates an empty singular wallpaper folder').toStrictEqual([])
})

test('imports a selected image and lists it immediately without overwriting a matching name', async () => {
  const { library, outside, folder } = await setupWallpapers()
  const original = await readFile(outside)
  const first = await library.importImage(outside)
  const second = await library.importImage(outside)
  expect(first.id).toBe('outside.png')
  expect(second.id).not.toBe(first.id)
  for (const imported of [first, second]) {
    expect(await readFile(join(folder, imported.id))).toEqual(original)
    expect(await library.list()).toContainEqual(imported)
    expect(await library.read(imported.id)).toMatch(/^data:image\/png;base64,/)
  }
  expect(await readFile(outside)).toEqual(original)
})

test('rejects invalid selected images before adding files to the library', async () => {
  const { library, folder } = await setupWallpapers()
  const before = await library.list()
  for (const id of ['corrupt.png', 'large.png', 'wide.png', 'pixels.png', 'truncated.png', 'disguised.png']) {
    await expect(library.importImage(join(folder, id))).rejects.toThrow(/Choose a valid/)
  }
  expect(await library.list()).toEqual(before)
})

test('orders supported images and returns original bytes with their detected MIME type', async () => {
  const { library, folder } = await setupWallpapers()
  const expected = ['A.jpeg', 'space name.webp', 'z.png']
  expect((await library.list()).map((entry) => entry.id)).toStrictEqual(expected)
  for (const id of expected) {
    const url = await library.read(id)
    const mime = id.endsWith('.jpeg') ? 'image/jpeg' : id.endsWith('.webp') ? 'image/webp' : 'image/png'
    expect(url).toBe(`data:${mime};base64,${(await readFile(join(folder, id))).toString('base64')}`)
  }
})

test('rejects traversal, symlinks, invalid images and byte, dimension and pixel limits', async () => {
  const { library, outside } = await setupWallpapers()
  for (const id of ['../outside.png', outside, '..\\outside.png', 'file:///outside.png', 'escape.png', 'internal-link.png', 'directory.png', 'large.png', 'wide.png', 'pixels.png', 'truncated.png', 'disguised.png', 'missing.png']) {
    expect(await library.read(id), id).toBe(null)
  }
})

test('handles deletion, permissions, removed folders and invalid folder replacements', async () => {
  const { library, folder, root } = await setupWallpapers()
  onTestCleanup(async () => {
    await chmod(folder, 0o700).catch(() => {})
    await chmod(join(folder, 'A.jpeg'), 0o600).catch(() => {})
  })
  await rm(join(folder, 'z.png'))
  expect(await library.read('z.png'), 'Deletion after listing is graceful').toBe(null)
  // Windows chmod does not remove read permissions; root can also bypass mode bits.
  if (process.platform !== 'win32' && process.getuid?.() !== 0) {
    await chmod(join(folder, 'A.jpeg'), 0)
    expect(await library.read('A.jpeg'), 'Unreadable images are skipped').toBe(null)
    await chmod(join(folder, 'A.jpeg'), 0o600)
    await chmod(folder, 0)
    await expect(library.list()).rejects.toThrow(/Cannot read wallpaper folder/)
    await chmod(folder, 0o700)
  }
  await rm(folder, { recursive: true })
  expect(await library.list(), 'Removed folders are recreated').toStrictEqual([])
  await rm(folder, { recursive: true })
  await symlink(root, folder)
  await expect(library.list()).rejects.toThrow(/Cannot read wallpaper folder/)
  expect(await library.read('outside.png')).toBe(null)
  await rm(folder)
  await writeFile(folder, 'blocked')
  await expect(library.list()).rejects.toThrow(/Cannot read wallpaper folder/)
})
