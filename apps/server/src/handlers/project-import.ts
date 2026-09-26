import { randomUUID } from 'node:crypto'
import { mkdir, lstat, open, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Project } from '@anvil/protocol/types'
import type { IpcRequests } from '@anvil/protocol/ipc-requests'
import type { Store } from '../store'

type Entry = IpcRequests['projects:import-begin']['entries'][number]

interface ImportSession {
  workspaceId: string
  name: string
  destination: string
  entries: Entry[]
  received: number[]
  busy: boolean
  timer?: NodeJS.Timeout
}

const CHUNK_LIMIT = 4 * 1024 * 1024
const TOTAL_LIMIT = 16 * 1024 * 1024 * 1024
const IDLE_TIMEOUT = 15 * 60 * 1000

function validComponent(value: string): boolean {
  return value.length > 0 && value.length <= 255 && value !== '.' && value !== '..' &&
    !/[<>:"\\|?*\x00-\x1f\x7f]/.test(value) && !/[. ]$/.test(value) &&
    !/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(value)
}

function validateManifest(name: string, entries: Entry[]): void {
  if (!validComponent(name)) throw new Error('Choose a folder with a valid project name')
  if (entries.length === 0 || entries.length > 20_000) throw new Error('Choose a folder containing at most 20,000 files and directories')
  const paths = new Map<string, Entry>()
  let total = 0
  let files = 0
  for (const entry of entries) {
    if (entry.path.length > 1024 || entry.path.startsWith('/') || entry.path.endsWith('/') ||
      entry.path.split('/').some((part) => !validComponent(part))) {
      throw new Error(`Unsupported project path: ${entry.path}`)
    }
    if (entry.type !== 'file' && entry.type !== 'directory') throw new Error(`Unsupported file type: ${entry.path}`)
    if (!Number.isSafeInteger(entry.size) || entry.size < 0 || (entry.type === 'directory' && entry.size !== 0)) {
      throw new Error(`Invalid file size: ${entry.path}`)
    }
    if (entry.type === 'directory' && entry.executable !== undefined) throw new Error(`Invalid directory metadata: ${entry.path}`)
    if (entry.path.toLowerCase() === '.git' && entry.type === 'file') {
      throw new Error('Linked Git worktrees with a .git file cannot be imported. Choose a checkout with its own .git directory')
    }
    const key = entry.path.toLowerCase()
    if (paths.has(key)) throw new Error(`Duplicate or conflicting project path: ${entry.path}`)
    paths.set(key, entry)
    if (entry.type === 'file') {
      files += 1
      total += entry.size
      if (total > TOTAL_LIMIT) throw new Error('Project exceeds the 16 GiB import limit')
    }
  }
  if (!files) throw new Error('Choose a folder containing files')
  for (const entry of entries) {
    const parts = entry.path.toLowerCase().split('/')
    for (let index = 1; index < parts.length; index++) {
      const parent = paths.get(parts.slice(0, index).join('/'))
      if (parent?.type === 'file') throw new Error(`A file cannot contain another project path: ${entry.path}`)
    }
  }
}

export function createProjectImporter(store: Store, projectsChanged?: (workspaceId: string) => void) {
  const sessions = new Map<string, ImportSession>()
  let preparing = 0

  async function cancel(importId: string): Promise<void> {
    const session = sessions.get(importId)
    if (!session) return
    sessions.delete(importId)
    clearTimeout(session.timer)
    while (session.busy) await new Promise<void>((resolve) => setTimeout(resolve, 10))
    await rm(session.destination, { recursive: true, force: true })
  }

  function refresh(importId: string, session: ImportSession): void {
    clearTimeout(session.timer)
    session.timer = setTimeout(() => { void cancel(importId) }, IDLE_TIMEOUT)
    session.timer.unref()
  }

  return {
    async begin({ workspaceId, name, entries }: IpcRequests['projects:import-begin']): Promise<{ importId: string }> {
      validateManifest(name, entries)
      if (sessions.size + preparing >= 4) throw new Error('Too many project imports are in progress. Finish or cancel one and try again')
      preparing += 1
      try {
        const root = join(store.getWorkspaceDirectory(workspaceId), 'projects')
        await mkdir(root, { recursive: true, mode: 0o700 })
        if ((await lstat(root)).isSymbolicLink()) throw new Error('Workspace projects directory cannot be a symbolic link')
        const destination = join(root, name)
        try {
          await mkdir(destination, { mode: 0o700 })
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error(`A project folder named ${name} already exists in this workspace`)
          throw error
        }
        const importId = randomUUID()
        const session: ImportSession = { workspaceId, name, destination, entries, received: entries.map(() => 0), busy: false }
        try {
          for (const entry of entries) {
            const path = join(destination, ...entry.path.split('/'))
            if (entry.type === 'directory') await mkdir(path, { recursive: true, mode: 0o700 })
            else {
              await mkdir(join(path, '..'), { recursive: true, mode: 0o700 })
              await writeFile(path, new Uint8Array(), { flag: 'wx', mode: entry.executable ? 0o700 : 0o600 })
            }
          }
          sessions.set(importId, session)
          refresh(importId, session)
          return { importId }
        } catch (error) {
          await rm(destination, { recursive: true, force: true })
          throw error
        }
      } finally {
        preparing -= 1
      }
    },
    async chunk({ importId, index, offset, bytes }: IpcRequests['projects:import-chunk']): Promise<void> {
      const session = sessions.get(importId)
      if (!session) throw new Error('Import expired or was cancelled. Choose the folder again')
      if (session.busy) throw new Error('Wait for the previous import chunk to finish')
      const entry = session.entries[index]
      if (!entry || entry.type !== 'file' || !bytes.byteLength || bytes.byteLength > CHUNK_LIMIT ||
        offset !== session.received[index] || offset + bytes.byteLength > entry.size) {
        await cancel(importId)
        throw new Error('Invalid import chunk. Choose the folder again')
      }
      session.busy = true
      try {
        const handle = await open(join(session.destination, ...entry.path.split('/')), 'r+')
        try {
          let written = 0
          while (written < bytes.byteLength) {
            const result = await handle.write(bytes, written, bytes.byteLength - written, offset + written)
            if (result.bytesWritten === 0) throw new Error('Could not write import chunk')
            written += result.bytesWritten
          }
        } finally {
          await handle.close()
        }
        session.received[index] += bytes.byteLength
        if (sessions.get(importId) !== session) throw new Error('Import was cancelled')
        refresh(importId, session)
      } catch (error) {
        session.busy = false
        await cancel(importId)
        throw error
      }
      session.busy = false
    },
    async finish(importId: string): Promise<Project> {
      const session = sessions.get(importId)
      if (!session) throw new Error('Import expired or was cancelled. Choose the folder again')
      if (session.busy) throw new Error('Wait for the current import chunk to finish')
      if (session.entries.some((entry, index) => entry.type === 'file' && session.received[index] !== entry.size)) {
        await cancel(importId)
        throw new Error('Import is incomplete. Choose the folder again')
      }
      sessions.delete(importId)
      clearTimeout(session.timer)
      const project: Project = {
        id: randomUUID(), name: session.name, path: session.destination, createdAt: Date.now(),
        monthlyTokenLimit: null, monthlyCostLimitUsd: null, finishOnPush: false, gitPlatform: 'github'
      }
      let added: Project
      try {
        added = store.addProject(project, session.workspaceId)
      } catch (error) {
        await rm(session.destination, { recursive: true, force: true })
        throw error
      }
      try {
        projectsChanged?.(session.workspaceId)
      } catch (error) {
        console.warn('Could not broadcast imported project:', error)
      }
      return added
    },
    cancel,
    async close(): Promise<void> {
      await Promise.all([...sessions.keys()].map((importId) => cancel(importId)))
    }
  }
}
