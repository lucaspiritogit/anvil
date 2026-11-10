import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { GitHubCredentialStatus } from '@anvil/protocol/types'

export interface CredentialEncryption {
  isEncryptionAvailable(): boolean
  getSelectedStorageBackend?(): string
  encryptString(value: string): Buffer
  decryptString(value: Buffer): string
}

/** The token never enters ordinary settings, renderer responses, or Git configuration. */
export class GitHubCredentials {
  constructor(
    private readonly path: string,
    private readonly encryption: CredentialEncryption,
    private readonly fallbackToken: () => Promise<string | null> = async () => null
  ) {}

  private requireEncryption(): void {
    if (!this.encryption.isEncryptionAvailable() || this.encryption.getSelectedStorageBackend?.() === 'basic_text') {
      throw new Error('Secure token storage is unavailable. Unlock or configure your system keychain first.')
    }
  }

  private async saved(): Promise<Buffer | null> {
    try {
      return await readFile(this.path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw new Error('Could not read GitHub credential storage.')
    }
  }

  async status(): Promise<GitHubCredentialStatus> {
    if (await this.saved()) return { configured: true, source: 'settings' }
    if (await this.fallbackToken()) return { configured: true, source: 'github-cli' }
    return { configured: false }
  }

  async getToken(): Promise<string> {
    const saved = await this.saved()
    if (!saved) {
      const token = await this.fallbackToken()
      if (token) return token
      throw new Error('Add a GitHub token in Settings, or run gh auth login on the Anvil server.')
    }
    this.requireEncryption()
    try {
      return this.encryption.decryptString(saved)
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
    return { configured: true, source: 'settings' }
  }

  async removeToken(): Promise<GitHubCredentialStatus> {
    await rm(this.path, { force: true })
    return this.status()
  }
}
