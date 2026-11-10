import type { DesktopUpdateState } from '@anvil/protocol/desktop-updates'

interface UpdateInfoLike {
  version: string
}

interface ProgressLike {
  percent: number
}

export interface UpdaterLike {
  autoDownload: boolean
  autoInstallOnAppQuit: boolean
  on(event: 'checking-for-update', listener: () => void): unknown
  on(event: 'update-available' | 'update-not-available' | 'update-downloaded', listener: (info: UpdateInfoLike) => void): unknown
  on(event: 'download-progress', listener: (progress: ProgressLike) => void): unknown
  on(event: 'error', listener: (error: Error) => void): unknown
  checkForUpdates(): Promise<{ downloadPromise?: Promise<unknown> | null } | null>
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void
}

export interface DesktopUpdateSupport {
  releaseBuild: boolean
  packaged: boolean
  platform: NodeJS.Platform
  env: NodeJS.ProcessEnv
  hasUpdateConfig: boolean
}

export function desktopUpdatesSupported(support: DesktopUpdateSupport): boolean {
  if (!support.releaseBuild || !support.packaged || !support.hasUpdateConfig) return false
  if (support.env.ANVIL_DISABLE_AUTO_UPDATE === '1') return false
  if (support.platform === 'linux') return Boolean(support.env.APPIMAGE)
  return support.platform === 'darwin' || support.platform === 'win32'
}

export function updateErrorMessage(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  const line = text.split('\n').find((value) => value.trim())?.trim() ?? 'Update failed'
  return line.length > 300 ? `${line.slice(0, 297)}...` : line
}

export class DesktopUpdates {
  private current: DesktopUpdateState
  private inFlight: Promise<DesktopUpdateState> | null = null

  constructor(
    private readonly updater: UpdaterLike | null,
    currentVersion: string,
    private readonly onChange: (state: DesktopUpdateState) => void,
    private readonly now: () => number = Date.now
  ) {
    this.current = {
      status: updater ? 'idle' : 'unsupported',
      currentVersion,
      version: null,
      progress: null,
      error: null,
      checkedAt: null
    }
    if (!updater) return
    updater.autoDownload = true
    updater.autoInstallOnAppQuit = true
    updater.on('checking-for-update', () => {
      if (this.current.status !== 'downloaded') this.update({ status: 'checking', error: null })
    })
    updater.on('update-available', (info) => {
      this.update({ status: 'downloading', version: info.version, progress: 0, error: null, checkedAt: this.now() })
    })
    updater.on('update-not-available', () => {
      this.update({ status: 'up-to-date', version: null, progress: null, error: null, checkedAt: this.now() })
    })
    updater.on('download-progress', (progress) => {
      if (this.current.status !== 'downloading') return
      const percent = Number.isFinite(progress.percent) ? Math.max(0, Math.min(100, progress.percent)) : 0
      this.update({ progress: percent })
    })
    updater.on('update-downloaded', (info) => {
      this.update({ status: 'downloaded', version: info.version, progress: 100, error: null })
    })
    updater.on('error', (error) => this.fail(error))
  }

  state(): DesktopUpdateState {
    return this.current
  }

  check(): Promise<DesktopUpdateState> {
    const updater = this.updater
    if (!updater) return Promise.resolve(this.current)
    if (this.current.status === 'downloading' || this.current.status === 'downloaded') return Promise.resolve(this.current)
    this.inFlight ??= (async () => {
      try {
        const result = await updater.checkForUpdates()
        result?.downloadPromise?.catch((error: unknown) => this.fail(error))
      } catch (error) {
        this.fail(error)
      }
      return this.current
    })().finally(() => { this.inFlight = null })
    return this.inFlight
  }

  install(): void {
    if (!this.updater || this.current.status !== 'downloaded') throw new Error('No downloaded update is ready to install.')
    this.updater.quitAndInstall(false, true)
  }

  private fail(error: unknown): void {
    if (this.current.status === 'downloaded') return
    this.update({ status: 'error', progress: null, error: updateErrorMessage(error), checkedAt: this.now() })
  }

  private update(patch: Partial<DesktopUpdateState>): void {
    this.current = { ...this.current, ...patch }
    this.onChange(this.current)
  }
}
