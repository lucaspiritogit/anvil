import { execFile } from 'node:child_process'
import type { WorkspaceExecutionContext } from './workspace-execution'
import { resolveCommand } from './resolve'
import { claudeWorkspaceEnvironment } from './claude-workspace'

export interface ClaudeAccountStatus {
  loggedIn: boolean
  subscription: boolean
  email: string | null
  subscriptionType: string | null
}

export function parseClaudeAccountStatus(value: unknown): ClaudeAccountStatus {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid Claude account status')
  const status = value as Record<string, unknown>
  if (typeof status.loggedIn !== 'boolean') throw new Error('Invalid Claude account status')
  const subscription = status.loggedIn && status.authMethod === 'claude.ai' && status.apiProvider === 'firstParty'
  return {
    loggedIn: status.loggedIn,
    subscription,
    email: subscription && typeof status.email === 'string' ? status.email : null,
    subscriptionType: subscription && typeof status.subscriptionType === 'string' ? status.subscriptionType : null
  }
}

export function readNativeClaudeAccount(workspace: WorkspaceExecutionContext): Promise<ClaudeAccountStatus> {
  const resolved = resolveCommand('claude')
  if (!resolved || resolved.viaShell) return Promise.reject(new Error('Claude Code unavailable'))
  return new Promise((resolve, reject) => {
    execFile(resolved.command, [...resolved.prefixArgs, 'auth', 'status', '--json'], {
      cwd: workspace.home, env: { ...claudeWorkspaceEnvironment(workspace), NO_COLOR: '1', FORCE_COLOR: '0' },
      timeout: 20_000, maxBuffer: 128_000, windowsHide: true
    }, (error, stdout) => {
      try {
        const status = parseClaudeAccountStatus(JSON.parse(stdout))
        if (error && (status.loggedIn || error.code !== 1)) throw new Error('Claude account status unavailable')
        resolve(status)
      } catch {
        reject(new Error('Claude account status unavailable'))
      }
    })
  })
}
