import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { argon2id, hash, verify } from 'argon2'

export const SERVER_AUTH_FILENAME = 'server-auth.json'

interface ServerAuthRecord {
  version: 1
  algorithm: 'argon2id'
  hash: string
}

export type ServerAuthStatus =
  | { configured: true }
  | { configured: false; reason: 'missing' | 'malformed' }

function isRecord(value: unknown): value is ServerAuthRecord {
  if (!value || typeof value !== 'object') return false
  const record = value as Partial<ServerAuthRecord>
  return record.version === 1
    && record.algorithm === 'argon2id'
    && typeof record.hash === 'string'
    && record.hash.startsWith('$argon2id$')
}

/** Stores the LAN server credential as a one-way hash in the server data directory. */
export class ServerAuth {
  private readonly path: string
  private readonly verificationKey = randomBytes(32)
  private verifiedPassword: { hash: string; fingerprint: Buffer } | undefined

  constructor(dataDirectory: string) {
    this.path = join(dataDirectory, SERVER_AUTH_FILENAME)
  }

  private async readRecord(): Promise<ServerAuthRecord | 'missing' | 'malformed'> {
    let contents: string
    try {
      if (process.platform !== 'win32') await chmod(this.path, 0o600)
      contents = await readFile(this.path, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing'
      throw new Error('Could not read server authentication storage.')
    }

    try {
      const value: unknown = JSON.parse(contents)
      if (!isRecord(value)) return 'malformed'
      return value
    } catch {
      return 'malformed'
    }
  }

  async status(): Promise<ServerAuthStatus> {
    const record = await this.readRecord()
    if (typeof record === 'string') return { configured: false, reason: record }
    try {
      // Argon2 performs the authoritative PHC-format validation. A false result is
      // expected here; this checks that the stored hash can safely be verified.
      await verify(record.hash, '')
      return { configured: true }
    } catch {
      return { configured: false, reason: 'malformed' }
    }
  }

  async setPassword(password: string): Promise<ServerAuthStatus> {
    if (typeof password !== 'string' || password.length === 0) {
      throw new Error('Server password must not be empty.')
    }

    const record: ServerAuthRecord = {
      version: 1,
      algorithm: 'argon2id',
      hash: await hash(password, { type: argon2id })
    }
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
    const temporary = `${this.path}.${randomUUID()}.tmp`
    try {
      await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, {
        mode: 0o600,
        flag: 'wx',
        flush: true
      })
      await rename(temporary, this.path)
      this.verifiedPassword = undefined
      if (process.platform !== 'win32') await chmod(this.path, 0o600)
    } finally {
      await rm(temporary, { force: true })
    }
    return { configured: true }
  }

  async verifyPassword(candidate: string): Promise<boolean> {
    if (typeof candidate !== 'string') return false
    const record = await this.readRecord()
    if (typeof record === 'string') {
      this.verifiedPassword = undefined
      return false
    }
    // Re-read the record on every request so password changes and removal take
    // effect immediately. Only reuse a successful check for that exact hash.
    const fingerprint = createHmac('sha256', this.verificationKey).update(candidate).digest()
    const cached = this.verifiedPassword
    if (cached?.hash === record.hash && timingSafeEqual(cached.fingerprint, fingerprint)) return true
    try {
      const accepted = await verify(record.hash, candidate)
      if (accepted) this.verifiedPassword = { hash: record.hash, fingerprint }
      return accepted
    } catch {
      return false
    }
  }
}
