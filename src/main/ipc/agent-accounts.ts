import type { RendererIpc } from '../renderer-security'
import type { WorkspaceAccounts } from '../agents/workspace-accounts'

export function registerAccountHandlers(ipc: RendererIpc, accounts: WorkspaceAccounts): void {
  ipc.handle('accounts:status', (_event, input) => accounts.status(input))
  ipc.handle('accounts:connect', (_event, input) => accounts.connect(input))
  ipc.handle('accounts:disconnect', (_event, input) => accounts.disconnect(input))
  ipc.handle('accounts:cancel', (_event, input) => accounts.cancel(input, input.sessionId))
  ipc.handle('accounts:terminal', (_event, input) => accounts.terminal(input, input.sessionId, input))
}
