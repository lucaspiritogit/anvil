export type DesktopUpdateStatus = 'unsupported' | 'idle' | 'checking' | 'up-to-date' | 'downloading' | 'downloaded' | 'error'

export interface DesktopUpdateState {
  status: DesktopUpdateStatus
  currentVersion: string
  version: string | null
  progress: number | null
  error: string | null
  checkedAt: number | null
}
