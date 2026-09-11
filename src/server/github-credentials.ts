import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { GitHubCredentialStatus } from '../shared/types'

export interface CredentialEncryption {
  isEncryptionAvailable(): boolean
  getSelectedStorageBackend?(): string
  encryptString(value: string): Buffer
  decryptString(value: Buffer): string
}

/** The token never enters ordinary settings, renderer responses, or Git configuration. */
export class GitHubCredentials {
  constructor(private readonly path: string, private readonly encryption: CredentialEncryption) {}

  private requireEncryption(): void {
    if (!this.encryption.isEncryptionAvailable() || this.encryption.getSelectedStorageBackend?.() === 'basic_text') {
      throw new Error('Secure token storage is unavailable. Unlock or configure your system keychain first.')
    }
  }

  async status(): Promise<GitHubCredentialStatus> {
    try {
      await readFile(this.path)
      return { configured: true }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { configured: false }
      throw new Error('Could not read GitHub credential storage.')
    }
  }

  async getToken(): Promise<string> {
    this.requireEncryption()
    try {
      return this.encryption.decryptString(await readFile(this.path))
    } catch {
      throw new Error('Add or replace your GitHub token in Settings.')
    }
  }

  async setToken(token: string): Promise<GitHubCredentialStatus> {
    this.requireEncryption()
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
    const temporary = `${this.path}.${randomUUID()}.tmp`
    try {
      await writeFile(temporary, this.encryption.encryptString(token), { mode: 0o600, flag: 'wx' })
      await rename(temporary, this.path)
    } finally {
      await rm(temporary, { force: true })
    }
    return { configured: true }
  }

  async removeToken(): Promise<GitHubCredentialStatus> {
    await rm(this.path, { force: true })
    return { configured: false }
  }
}
