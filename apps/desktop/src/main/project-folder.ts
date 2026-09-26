import { dialog } from 'electron'
import { randomUUID } from 'node:crypto'
import { open, readdir, lstat, realpath } from 'node:fs/promises'
import { constants } from 'node:fs'
import { basename, join, relative, sep } from 'node:path'

type Entry = { path: string; type: 'file' | 'directory'; size: number; executable?: boolean }
const selections = new Map<string, { root: string; entries: Entry[] }>()

export async function pickProjectFolder(): Promise<{ token: string; name: string; entries: Entry[] } | null> {
  const chosen = await dialog.showOpenDialog({ title: 'Add project from disk', properties: ['openDirectory'] })
  if (chosen.canceled || !chosen.filePaths[0]) return null
  const root = await realpath(chosen.filePaths[0])
  const entries: Entry[] = []
  const scan = async (directory: string): Promise<void> => {
    for (const item of await readdir(directory, { withFileTypes: true })) {
      const full = join(directory, item.name)
      const path = relative(root, full).split('\\').join('/')
      const info = await lstat(full)
      if (info.isSymbolicLink()) throw new Error(`The selected folder contains a symbolic link: ${path}`)
      if (info.isDirectory()) {
        entries.push({ path, type: 'directory', size: 0 })
        await scan(full)
      } else if (info.isFile()) {
        entries.push({ path, type: 'file', size: info.size, executable: !!(info.mode & 0o111) })
      } else throw new Error(`The selected folder contains an unsupported entry: ${path}`)
      if (entries.length > 20_000) throw new Error('The selected folder has too many entries (limit: 20,000)')
    }
  }
  await scan(root)
  if (!entries.length) throw new Error('Choose a folder with project files')
  const token = randomUUID()
  selections.set(token, { root, entries })
  return { token, name: basename(root), entries }
}

export async function readProjectFile(input: { token: string; index: number; offset: number; length: number }): Promise<Uint8Array> {
  const selection = selections.get(input.token)
  const entry = selection?.entries[input.index]
  if (!selection || !entry || entry.type !== 'file' || !Number.isSafeInteger(input.offset) || !Number.isSafeInteger(input.length) ||
    input.offset < 0 || input.length < 1 || input.length > 4 * 1024 * 1024 || input.offset + input.length > entry.size) {
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
  } finally { await handle.close() }
}

export function releaseProjectFolder(token: string): void { selections.delete(token) }
