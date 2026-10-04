import { GhosttyTerminal } from './GhosttyTerminal'
import { TerminalAuthInput } from './TerminalAuthInput'
import { Select } from './Select'
import { AgentIcon } from './AgentIcon'
import { useEffect, useRef, useState, type JSX } from 'react'
import type { AgentAccountConnect, AgentAccountTarget, WorkspaceAgentAccount } from '@anvil/protocol/types'
import { useStore } from '../state/store'
import { btn, cn, field } from '../ui'

function AccountRow({ workspaceId, workspaceName, agentId }: AgentAccountTarget & { workspaceName: string }): JSX.Element {
  const [account, setAccount] = useState<WorkspaceAgentAccount | null>(null)
  const [apiKey, setApiKey] = useState('')
  const [accountType, setAccountType] = useState<'apiKey' | 'chatgpt'>('chatgpt')
  const [chatgptSignInFlow, setChatgptSignInFlow] = useState<'browser' | 'deviceCode'>('browser')
  const [requesting, setRequesting] = useState(false)
  const [revealed, setRevealed] = useState(false)
  const mounted = useRef(true)
  const accountRef = useRef(account)
  accountRef.current = account
  const label = agentId === 'codex' ? 'Codex' : agentId === 'claude' ? 'Claude' : 'OpenCode'
  const target = { workspaceId, agentId }
  const refresh = async (): Promise<void> => {
    try {
      const next = await window.anvil.accounts.status(target)
      if (mounted.current) setAccount(next)
    } catch {
      if (mounted.current) setAccount({ ...target, workspaceName, status: 'error', accounts: [], busy: false, message: 'Could not refresh account status. Retry when ready.' })
    }
  }
  useEffect(() => {
    mounted.current = true
    const off = window.anvil.accounts.onChanged((next) => {
      if (next.workspaceId === workspaceId && next.agentId === agentId) setAccount(next)
    })
    void refresh()
    const timer = setInterval(() => { if (accountRef.current?.busy) void refresh() }, 3000)
    return () => { mounted.current = false; clearInterval(timer); off() }
  }, [workspaceId, agentId])

  const run = async (operation: () => Promise<WorkspaceAgentAccount>): Promise<void> => {
    setRequesting(true)
    try {
      const next = await operation()
      if (mounted.current) setAccount(next)
    } catch {
      if (mounted.current) setAccount({ ...target, workspaceName, status: 'error', accounts: [], busy: false, message: 'Account operation failed. Retry when ready.' })
    } finally { if (mounted.current) setRequesting(false) }
  }
  const connect = (): void => {
    let method: AgentAccountConnect['method'] = 'native'
    if (agentId === 'codex' && accountType === 'apiKey') method = 'apiKey'
    if (agentId === 'codex' && accountType === 'chatgpt' && chatgptSignInFlow === 'browser') method = 'chatgpt'
    if (agentId === 'codex' && accountType === 'chatgpt' && chatgptSignInFlow === 'deviceCode') method = 'deviceAuth'
    const input: AgentAccountConnect = { ...target, method,
      ...(agentId === 'codex' && accountType === 'apiKey' ? { apiKey } : {}) }
    setApiKey('')
    void run(() => window.anvil.accounts.connect(input))
  }
  const pending = account?.status === 'pending'
  const disabled = requesting || pending || account?.busy || !account
  return (
    <section className="border-b border-line px-3 py-3 last:border-b-0" aria-label={`${label} account for ${workspaceName}`}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <div className="flex min-w-[120px] flex-1 items-center gap-2.5">
          <AgentIcon agentId={agentId} label={label} size={22} />
          <div className="min-w-0">
            <h3 className="text-sm font-medium">{label}</h3>
            <div role="status" className="mt-0.5 break-words text-xs text-dim">
              {!account
                ? <p>Reading account…</p>
                : account.status === 'connected'
                  ? agentId === 'codex' || agentId === 'claude'
                    ? <button type="button" aria-pressed={revealed} title={revealed ? 'Hide email' : 'Reveal email'}
                        className={cn('max-w-full cursor-pointer break-all text-left transition-[filter] duration-150 focus-visible:outline focus-visible:outline-accent', !revealed && 'select-none blur-[3px]')}
                        onClick={() => setRevealed((value) => !value)}>
                        {account.accounts.join(', ')}
                      </button>
                    : <p>{account.accounts.join(', ')}</p>
                  : <p>{account.status === 'signed-out' ? 'Signed out' : account.message}</p>}
            </div>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <button className={cn(btn.primary, 'h-8 text-xs')} aria-label={`Connect ${label} for ${workspaceName}`}
            disabled={disabled || (agentId === 'codex' && accountType === 'apiKey' && !apiKey.trim())} onClick={connect}>Connect</button>
          {account?.status === 'connected' && <button className={cn(btn.ghost, 'h-8 text-xs')} aria-label={`Disconnect ${label} for ${workspaceName}`}
            disabled={disabled} onClick={() => void run(() => window.anvil.accounts.disconnect(target))}>Disconnect</button>}
          <button className={cn(btn.ghost, 'h-8 text-xs')} aria-label={`Refresh ${label} for ${workspaceName}`}
            disabled={requesting || pending} onClick={() => void run(() => window.anvil.accounts.status(target))}>Refresh</button>
          {pending && account.sessionId && <button className={cn(btn.ghost, 'h-8 text-xs')} aria-label={`Cancel ${label} for ${workspaceName}`}
            onClick={() => void run(() => window.anvil.accounts.cancel({ ...target, sessionId: account.sessionId! }))}>Cancel</button>}
        </div>
      </div>
      {account?.busy && <p className="mt-2 text-xs text-dim">Active work in {workspaceName} must finish before changing accounts.</p>}
      {agentId === 'codex' && !pending && <>
        <div className="mt-3 grid gap-2.5 sm:grid-cols-2">
          <label>
            <span className={field.label}>Account type</span>
            <Select compact aria-label={`Codex account type for ${workspaceName}`} value={accountType} disabled={disabled} onChange={(event) => { setAccountType(event.target.value as typeof accountType); setApiKey('') }}>
              <option value="chatgpt">ChatGPT subscription</option>
              <option value="apiKey">API key</option>
            </Select>
          </label>
          {accountType === 'chatgpt' && <label>
            <span className={field.label}>Sign-in method</span>
            <Select compact aria-label={`ChatGPT sign-in flow for ${workspaceName}`} value={chatgptSignInFlow} disabled={disabled} onChange={(event) => setChatgptSignInFlow(event.target.value as typeof chatgptSignInFlow)}>
              <option value="browser">Browser on this PC</option>
              <option value="deviceCode">One-time device code</option>
            </Select>
          </label>}
          {accountType === 'apiKey' && <label>
            <span className={field.label}>API key</span>
            <input className={cn(field.control, 'h-8 px-2.5 text-xs')} aria-label={`Codex API key for ${workspaceName}`} type="password" autoComplete="off" spellCheck={false} value={apiKey}
              disabled={disabled} onChange={(event) => setApiKey(event.target.value)} />
          </label>}
        </div>
        {accountType === 'chatgpt' && chatgptSignInFlow === 'deviceCode' && <p className="mt-2 text-xs text-dim">Open the verification link from any device and enter the one-time code in the terminal panel. This signs Codex in with your ChatGPT subscription.</p>}
      </>}
      {agentId === 'opencode' && account?.status !== 'connected' && !pending && <p className="mt-2 text-xs text-dim">Choose an API key or subscription in OpenCode's provider prompts.</p>}
      {agentId === 'claude' && pending && account.authAction === 'sign-in' && <p className="mt-2 text-xs text-dim">Complete the browser sign-in, then paste, review, and send its code below when prompted.</p>}
      {pending && (agentId === 'opencode' || agentId === 'claude') && <p className="mt-3 text-xs text-dim">Complete sign-in or sign-out in the terminal panel. Cancelling stops the command.</p>}
      {pending && account.terminalSessionId && <GhosttyTerminal key={account.terminalSessionId} sessionId={account.terminalSessionId} className="mt-3 h-[180px]" />}
      {pending && agentId === 'claude' && account.authAction === 'sign-in' && account.terminalSessionId && <TerminalAuthInput key={account.terminalSessionId} sessionId={account.terminalSessionId} />}
    </section>
  )
}

export function WorkspaceAgentAccounts(): JSX.Element {
  const workspaceId = useStore((state) => state.activeWorkspaceId)
  const workspaceName = useStore((state) => state.workspaces.find((workspace) => workspace.id === workspaceId)?.name ?? 'Workspace')
  if (!workspaceId) return <p>Select a workspace to manage accounts.</p>
  return <div>
    <h2 className="font-medium">Accounts for {workspaceName}</h2>
    <p className="mt-1 text-xs text-dim">Account changes apply immediately to this workspace. Credentials stay in the agent's workspace profile.</p>
    <div className="mt-3 overflow-hidden rounded-lg border border-line">
      {(['codex', 'claude', 'opencode'] as const).map((agentId) => <AccountRow key={`${workspaceId}:${agentId}`} workspaceId={workspaceId} workspaceName={workspaceName} agentId={agentId} />)}
    </div>
  </div>
}
