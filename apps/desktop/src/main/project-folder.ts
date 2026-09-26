import { dialog } from 'electron'
import { randomUUID } from 'node:crypto'
import { open, readdir, lstat, realpath } from 'node:fs/promises'
import { constants } from 'node:fs'
import { basename, join, relative, sep } from 'node:path'

interface Entry {
  path: string
  type: 'file' | 'directory'
  size: number
  executable?: boolean
}

interface Selection {
  root: string
  entries: Entry[]
}

const MAX_ENTRIES = 20_000
const MAX_READ_SIZE = 4 * 1024 * 1024
const selections = new Map<string, Selection>()

async function scanFolder(root: string, directory: string, entries: Entry[]): Promise<void> {
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const fullPath = join(directory, item.name)
    const entryPath = relative(root, fullPath).split('\\').join('/')
    const info = await lstat(fullPath)

    if (info.isSymbolicLink()) throw new Error(`The selected folder contains a symbolic link: ${entryPath}`)
    if (info.isDirectory()) {
      entries.push({ path: entryPath, type: 'directory', size: 0 })
      await scanFolder(root, fullPath, entries)
    } else if (info.isFile()) {
      entries.push({ path: entryPath, type: 'file', size: info.size, executable: !!(info.mode & 0o111) })
    } else {
      throw new Error(`The selected folder contains an unsupported entry: ${entryPath}`)
    }

    if (entries.length > MAX_ENTRIES) {
      throw new Error(`The selected folder has too many entries (limit: ${MAX_ENTRIES.toLocaleString()})`)
    }
  }
}

export async function pickProjectFolder(): Promise<{ token: string; name: string; entries: Entry[] } | null> {
  const chosen = await dialog.showOpenDialog({ title: 'Add project from disk', properties: ['openDirectory'] })
  if (chosen.canceled || !chosen.filePaths[0]) return null

  const root = await realpath(chosen.filePaths[0])
  const entries: Entry[] = []
  await scanFolder(root, root, entries)
  if (!entries.length) throw new Error('Choose a folder with project files')

  const token = randomUUID()
  selections.set(token, { root, entries })
  return { token, name: basename(root), entries }
}

export async function readProjectFile(input: { token: string; index: number; offset: number; length: number }): Promise<Uint8Array> {
  const selection = selections.get(input.token)
  const entry = selection?.entries[input.index]
  const validRange = Number.isSafeInteger(input.offset) && Number.isSafeInteger(input.length) &&
    input.offset >= 0 && input.length >= 1 && input.length <= MAX_READ_SIZE
  if (!selection || !entry || entry.type !== 'file' || !validRange || input.offset + input.length > entry.size) {
    throw new Error('Invalid project file read')
  }

  const path = join(selection.root, entry.path)
  const resolved = await realpath(path)
  if (!resolved.startsWith(selection.root + sep)) throw new Error(`Project file changed during import: ${entry.path}`)

  const info = await lstat(path)
  if (!info.isFile() || info.isSymbolicLink() || info.size !== entry.size) throw new Error(`Project file changed during import: ${entry.path}`)

  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const bytes = Buffer.alloc(input.length)
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, input.offset)
    if (bytesRead !== bytes.length) throw new Error(`Could not read all of ${entry.path}`)
    return bytes
  } finally {
    await handle.close()
  }
}

export function releaseProjectFolder(token: string): void {
  selections.delete(token)
}
