import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { normalizeServerTarget, serverAddress, type ServerTarget } from '@anvil/protocol/server-address'

export const SERVER_CONNECTION_SETTINGS_FILENAME = 'server-connection.json'

interface StoredServerConnectionSettings {
  version: 1
  target: ServerTarget
}

function storedTarget(value: unknown): ServerTarget | undefined {
  if (!value || typeof value !== 'object') return undefined
  const record = value as Partial<StoredServerConnectionSettings>
  if (record.version !== 1) return undefined
  try {
    return normalizeServerTarget(record.target)
  } catch {
    return undefined
  }
}

export function resolveServerTarget(saved: ServerTarget | undefined, environment: NodeJS.ProcessEnv): ServerTarget {
  if (saved) return normalizeServerTarget(saved)
  if (environment.ANVIL_SERVER_URL) {
    return { mode: 'remote', url: serverAddress(environment.ANVIL_SERVER_URL) }
  }
  return { mode: 'local' }
}

export class ServerConnectionSettings {
  private readonly path: string

  constructor(private readonly profileDirectory: string) {
    this.path = join(profileDirectory, SERVER_CONNECTION_SETTINGS_FILENAME)
  }

  async load(): Promise<ServerTarget | undefined> {
    let contents: string
    try {
      contents = await readFile(this.path, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw new Error('Could not read the saved Anvil server target.', { cause: error })
    }
    try {
      return storedTarget(JSON.parse(contents))
    } catch {
      return undefined
    }
  }

  async resolve(environment: NodeJS.ProcessEnv = process.env): Promise<ServerTarget> {
    return resolveServerTarget(await this.load(), environment)
  }

  async save(target: ServerTarget): Promise<ServerTarget> {
    const normalized = normalizeServerTarget(target)
    const record: StoredServerConnectionSettings = { version: 1, target: normalized }
    await mkdir(this.profileDirectory, { recursive: true, mode: 0o700 })
    const temporary = `${this.path}.${randomUUID()}.tmp`
    try {
      await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600, flag: 'wx', flush: true })
      await rename(temporary, this.path)
    } finally {
      await rm(temporary, { force: true })
    }
    return normalized
  }

  async clear(): Promise<void> {
    await rm(this.path, { force: true })
  }
}
