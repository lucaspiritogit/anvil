import { normalizeServerTarget, type ServerTarget } from '@anvil/protocol/server-address'
import type { DesktopServerConnectionState } from '@anvil/protocol/desktop-requests'
import type { ServerConnection } from './server-process'

export type ServerConnectionState = DesktopServerConnectionState

interface ServerTargetSettings {
  load(): Promise<ServerTarget | undefined>
  resolve(environment?: NodeJS.ProcessEnv): Promise<ServerTarget>
  save(target: ServerTarget): Promise<ServerTarget>
  clear(): Promise<void>
}

interface ActiveConnection extends ServerConnectionState {
  connection: ServerConnection
  stopActivity(): void
}

export interface ServerConnectionManagerOptions {
  settings: ServerTargetSettings
  connect(target: ServerTarget): Promise<ServerConnection>
  reconnect(state: ServerConnectionState): Promise<void>
  startActivity(url: string): () => void
  reportCleanupError?(error: unknown): void
}

function sameTarget(left: ServerTarget, right: ServerTarget): boolean {
  return left.mode === right.mode && (left.mode === 'local' || right.mode === 'local' || left.url === right.url)
}

export class ServerConnectionManager {
  private active?: ActiveConnection
  private changes: Promise<void> = Promise.resolve()

  constructor(private readonly options: ServerConnectionManagerOptions) {}

  state(): ServerConnectionState {
    if (!this.active) throw new Error('Anvil has not connected to a server yet.')
    return { target: this.active.target, url: this.active.url }
  }

  async start(target?: ServerTarget, persist = false): Promise<ServerConnectionState> {
    if (this.active) return this.state()
    const normalized = normalizeServerTarget(target ?? await this.options.settings.resolve())
    const connection = await this.options.connect(normalized)
    try {
      if (persist) await this.options.settings.save(normalized)
      const stopActivity = this.options.startActivity(connection.url)
      this.active = { target: normalized, url: connection.url, connection, stopActivity }
      return this.state()
    } catch (error) {
      await connection.close().catch((cleanupError) => this.reportCleanupError(cleanupError))
      throw error
    }
  }

  setTarget(target: ServerTarget): Promise<ServerConnectionState> {
    const operation = this.changes.then(() => this.changeTarget(target))
    this.changes = operation.then(() => {}, () => {})
    return operation
  }

  async close(): Promise<void> {
    await this.changes
    const active = this.active
    this.active = undefined
    if (!active) return
    this.stopActivity(active.stopActivity)
    await active.connection.close()
  }

  private async changeTarget(target: ServerTarget): Promise<ServerConnectionState> {
    const current = this.active
    if (!current) throw new Error('Anvil has not connected to a server yet.')
    const normalized = normalizeServerTarget(target)
    if (sameTarget(current.target, normalized)) return this.state()

    const saved = await this.options.settings.load()
    const candidate = await this.options.connect(normalized)
    let stopCandidateActivity: (() => void) | undefined
    let preferenceChanged = false
    try {
      stopCandidateActivity = this.options.startActivity(candidate.url)
      await this.options.settings.save(normalized)
      preferenceChanged = true
      const state = { target: normalized, url: candidate.url }
      await this.options.reconnect(state)
      if (candidate.url === current.url) {
        this.stopActivity(stopCandidateActivity)
        await candidate.close().catch((cleanupError) => this.reportCleanupError(cleanupError))
        this.active = { ...state, connection: current.connection, stopActivity: current.stopActivity }
        return this.state()
      }
      this.active = { ...state, connection: candidate, stopActivity: stopCandidateActivity }
      this.stopActivity(current.stopActivity)
      await current.connection.close().catch((error) => this.reportCleanupError(error))
      return this.state()
    } catch (error) {
      if (stopCandidateActivity) this.stopActivity(stopCandidateActivity)
      await candidate.close().catch((cleanupError) => this.reportCleanupError(cleanupError))
      if (preferenceChanged) {
        try {
          if (saved) await this.options.settings.save(saved)
          else await this.options.settings.clear()
        } catch (restoreError) {
          throw new Error(`${error instanceof Error ? error.message : String(error)} The previous server preference could not be restored.`, { cause: restoreError })
        }
      }
      throw error
    }
  }

  private reportCleanupError(error: unknown): void {
    try {
      this.options.reportCleanupError?.(error)
    } catch {}
  }

  private stopActivity(stop: () => void): void {
    try {
      stop()
    } catch (error) {
      this.reportCleanupError(error)
    }
  }
}
