import { constants, mkdirSync, realpathSync } from 'node:fs'
import { lstat, open, readdir, realpath, writeFile } from 'node:fs/promises'
import { basename, extname, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { validateImageHeaders } from '../shared/image-headers'
import { isWallpaperId } from '../shared/appearance'
import type { Wallpaper } from '../shared/types'

export const MAX_WALLPAPER_BYTES = 10 * 1024 * 1024
export const MAX_WALLPAPER_PIXELS = 16_777_216
export const MAX_WALLPAPER_DIMENSION = 8192

/** A flat, local library. No renderer-supplied paths and no persistent image bytes. */
export class WallpaperLibrary {
  readonly directory: string
  private pending: Promise<unknown> = Promise.resolve()

  constructor(configDirectory: string) {
    let configPath = resolve(configDirectory)
    try {
      mkdirSync(configPath, { recursive: true })
      configPath = realpathSync(configPath)
    } catch { /* Reads below handle an inaccessible config directory. */ }
    this.directory = join(configPath, 'wallpaper')
    this.ensureDirectory()
  }

  private ensureDirectory(): void {
    try { mkdirSync(this.directory, { recursive: true }) } catch { /* Unavailable libraries are empty. */ }
  }

  // Serialize reads so concurrent IPC cannot multiply image buffer memory.
  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.pending.then(operation)
    this.pending = result.catch(() => undefined)
    return result
  }

  private async availableDirectory(): Promise<boolean> {
    this.ensureDirectory()
    try {
      return (await lstat(this.directory)).isDirectory() && await realpath(this.directory) === this.directory
    } catch {
      return false
    }
  }

  private async load(id: string, path = join(this.directory, id)): Promise<{ wallpaper: Wallpaper; dataUrl: string; bytes: Buffer } | null> {
    if (!isWallpaperId(id) || id.length > 255) return null
    try {
      if (await realpath(path) !== path) return null
      // NOFOLLOW rejects a file swapped for a symlink between checking and opening.
      const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
      let bytes: Buffer
      try {
        const stat = await handle.stat()
        if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_WALLPAPER_BYTES) return null
        // A fixed buffer also bounds files that grow after stat.
        const buffer = Buffer.alloc(MAX_WALLPAPER_BYTES + 1)
        let length = 0
        while (length < buffer.length) {
          const read = await handle.read(buffer, length, buffer.length - length, length)
          if (!read.bytesRead) break
          length += read.bytesRead
        }
        if (!length || length > MAX_WALLPAPER_BYTES) return null
        bytes = buffer.subarray(0, length)
      } finally {
        await handle.close()
      }
      const { width, height, mimeType } = validateImageHeaders(bytes, { pixels: MAX_WALLPAPER_PIXELS, dimension: MAX_WALLPAPER_DIMENSION })
      return { wallpaper: { id, name: id, width, height }, dataUrl: `data:${mimeType};base64,${bytes.toString('base64')}`, bytes }
    } catch {
      return null
    }
  }

  /** Only main-process file picker results may supply a source path. */
  importImage(sourcePath: string): Promise<Wallpaper> {
    return this.serialize(async () => {
      if (!await this.availableDirectory()) throw new Error('Cannot write to the wallpaper folder')
      const name = basename(sourcePath)
      const loaded = await this.load(name, await realpath(sourcePath))
      if (!loaded) throw new Error('Choose a valid PNG, JPEG or WebP image up to 10 MB and 8192 pixels per side, with no more than 16 megapixels.')
      let id = name
      try {
        await writeFile(join(this.directory, id), loaded.bytes, { flag: 'wx' })
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        const extension = extname(name)
        id = `${basename(name, extension).slice(0, 40)}-${randomUUID()}${extension}`
        await writeFile(join(this.directory, id), loaded.bytes, { flag: 'wx' })
      }
      return { ...loaded.wallpaper, id, name: id }
    })
  }

  list(): Promise<Wallpaper[]> {
    return this.serialize(async () => {
      if (!await this.availableDirectory()) throw new Error('Cannot read wallpaper folder')
      try {
        const entries = await readdir(this.directory, { withFileTypes: true })
        const ids = entries.filter((entry) => entry.isFile() && isWallpaperId(entry.name)).map((entry) => entry.name).sort()
        const wallpapers: Wallpaper[] = []
        for (const id of ids) {
          const loaded = await this.load(id)
          if (loaded) wallpapers.push(loaded.wallpaper)
        }
        return wallpapers
      } catch {
        throw new Error('Cannot read wallpaper folder')
      }
    })
  }

  /** Missing, removed or invalid images return null so the overview can use its color. */
  read(id: string): Promise<string | null> {
    return this.serialize(async () => {
      if (!await this.availableDirectory()) return null
      return (await this.load(id))?.dataUrl ?? null
    })
  }
}
