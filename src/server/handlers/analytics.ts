import type { WorkspaceAnalytics } from '../../shared/types'
import type { HandlerRegistry } from '../handler-registry'
import type { Store } from '../store'

export function registerAnalyticsHandlers(ipc: HandlerRegistry, store: Store): void {
  ipc.handle('analytics:get', (range): WorkspaceAnalytics => store.getAnalytics(range))
}
