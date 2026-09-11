import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { TaskImageAttachment } from '../shared/types'
import { parseTaskImages } from './task-images'

/** Task-owned originals for restart/fresh-session recovery, never agent-visible paths. */
export class TaskImageStorage {
  constructor(private readonly root: string | ((taskId: string) => string)) {}

  private path(taskId: string): string {
    if (!/^[A-Za-z0-9_-]+$/.test(taskId)) throw new Error('Invalid task image owner')
    const root = typeof this.root === 'string' ? this.root : this.root(taskId)
    return join(root, taskId)
  }

  save(taskId: string, images: TaskImageAttachment[]): void {
    if (!images.length) return
    const target = this.path(taskId)
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 })
    const pending = `${target}-${randomUUID()}.pending`
    mkdirSync(pending, { mode: 0o700 })
    try {
      images.forEach((image, index) => writeFileSync(join(pending, `${index}.image`), image.bytes, { mode: 0o600 }))
      writeFileSync(join(pending, 'manifest.json'), JSON.stringify(images.map(({ filename, mimeType }) => ({ filename, mimeType }))), { mode: 0o600 })
      renameSync(pending, target)
    } finally {
      rmSync(pending, { recursive: true, force: true })
    }
  }

  read(taskId: string): TaskImageAttachment[] | undefined {
    const directory = this.path(taskId)
    if (!existsSync(directory)) return undefined
    try {
      const manifest = JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8')) as Array<{ filename: string; mimeType: string }>
      return parseTaskImages(manifest.map((image, index) => ({ ...image, bytes: new Uint8Array(readFileSync(join(directory, `${index}.image`))) })))
    } catch {
      throw new Error('Saved task images are unreadable. Start a new task and attach the original images again.')
    }
  }

  /** Remove interrupted writes and originals whose owner was deleted or cancelled. */
  prune(owners: Set<string>): void {
    if (typeof this.root !== 'string') throw new Error('Prune one workspace image directory at a time')
    if (!existsSync(this.root)) return
    for (const name of readdirSync(this.root)) {
      if (!owners.has(name)) rmSync(join(this.root, name), { recursive: true, force: true })
    }
  }

  remove(taskId: string): void {
    rmSync(this.path(taskId), { recursive: true, force: true })
  }
}
