import type { HandlerRegistry } from '../handler-registry'
import type { WorkspaceAccounts } from '../agents/workspace-accounts'

export function registerAccountHandlers(ipc: HandlerRegistry, accounts: WorkspaceAccounts): void {
  ipc.handle('accounts:status', (input) => accounts.status(input))
  ipc.handle('accounts:connect', (input) => accounts.connect(input))
  ipc.handle('accounts:disconnect', (input) => accounts.disconnect(input))
  ipc.handle('accounts:cancel', (input) => accounts.cancel(input, input.sessionId))
}
