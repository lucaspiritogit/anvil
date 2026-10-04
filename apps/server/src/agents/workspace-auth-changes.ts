import { readFileSync, statSync, unwatchFile, watchFile, type BigIntStats } from 'node:fs'
import { basename, join } from 'node:path'
import type { Store } from '../store'
import { claudeWorkspaceProfile } from './workspace-execution'

const AUTH_FILES = [
  ['codex', 'auth.json'],
  ['codex', 'config.toml'],
  ['data', 'opencode', 'auth.json'],
  ['config', 'opencode', 'opencode.json'],
  ['config', 'opencode', 'opencode.jsonc']
]

function workspaceAuthFiles(store: Store, workspaceId: string): string[] {
  const directory = store.getWorkspaceDirectory(workspaceId)
  const claudeHome = claudeWorkspaceProfile(directory, workspaceId)
  return [
    ...AUTH_FILES.map((file) => join(directory, ...file)),
    ...['.claude.json', '.credentials.json', 'settings.json'].map((file) => join(claudeHome, file))
  ]
}

function revision(path: string, stats: BigIntStats | undefined): string {
  if (basename(path) === '.claude.json') {
    try {
      const configuration = !stats || stats.nlink === 0n ? {} : JSON.parse(readFileSync(path, 'utf8'))
      const account = configuration.oauthAccount
      return JSON.stringify({
        primaryApiKey: configuration.primaryApiKey ?? null,
        oauthAccount: account ? {
          accountUuid: account.accountUuid,
          emailAddress: account.emailAddress,
          organizationUuid: account.organizationUuid,
          billingType: account.billingType,
          organizationType: account.organizationType,
          organizationRateLimitTier: account.organizationRateLimitTier,
          userRateLimitTier: account.userRateLimitTier,
          subscriptionType: account.subscriptionType,
          seatTier: account.seatTier,
          planDisplayName: account.planDisplayName,
          claudeCodeTrialEndsAt: account.claudeCodeTrialEndsAt
        } : null
      })
    } catch {
      return 'unavailable'
    }
  }
  if (!stats || stats.nlink === 0n) return 'missing'
  return `${stats.dev}:${stats.ino}:${stats.size}:${stats.mtimeNs}:${stats.ctimeNs}`
}

/** Observe atomic credential replacements as well as edits, including newly created profiles. */
export function watchWorkspaceAuthChanges(
  store: Store,
  changed: (workspaceId: string) => void
): () => void {
  const subscriptions = new Map<string, { workspaceId: string, close: () => void }>()
  let closed = false
  const reconcile = (): void => {
    const paths = new Map<string, string>()
    for (const workspace of store.getWorkspaces()) {
      for (const file of workspaceAuthFiles(store, workspace.id)) paths.set(file, workspace.id)
    }
    for (const [path, subscription] of subscriptions) {
      if (paths.get(path) === subscription.workspaceId) continue
      subscription.close()
      subscriptions.delete(path)
    }
    for (const [path, workspaceId] of paths) {
      if (subscriptions.has(path)) continue
      let previous = revision(path, statSync(path, { bigint: true, throwIfNoEntry: false }))
      const listener = (stats: BigIntStats): void => {
        if (closed || subscriptions.get(path)?.workspaceId !== workspaceId) return
        const next = revision(path, stats)
        if (next === previous) return
        previous = next
        const workspace = store.getWorkspaces().find((workspace) => workspace.id === workspaceId)
        if (workspace && workspaceAuthFiles(store, workspaceId).includes(path)) {
          changed(workspaceId)
        }
      }
      // Poll only known files. Recursive fs.watch also watches every worktree's
      // dependencies and can exhaust Linux inotify limits before filtering events.
      watchFile(path, { bigint: true, persistent: false, interval: 1_000 }, listener)
      subscriptions.set(path, { workspaceId, close: () => unwatchFile(path, listener) })
    }
  }
  reconcile()
  const timer = setInterval(reconcile, 1_000)
  timer.unref()
  return () => {
    closed = true
    clearInterval(timer)
    for (const subscription of subscriptions.values()) subscription.close()
    subscriptions.clear()
  }
}
