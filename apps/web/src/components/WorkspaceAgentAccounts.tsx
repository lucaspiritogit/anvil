import { GhosttyTerminal } from './GhosttyTerminal'
import { Select } from './Select'
import { useEffect, useRef, useState, type JSX } from 'react'
import type { AgentAccountConnect, AgentAccountTarget, WorkspaceAgentAccount } from '@anvil/protocol/types'
import { useStore } from '../state/store'
import { btn, cn, field } from '../ui'

function AccountCard({ workspaceId, workspaceName, agentId }: AgentAccountTarget & { workspaceName: string }): JSX.Element {
  const [account, setAccount] = useState<WorkspaceAgentAccount | null>(null)
  const [apiKey, setApiKey] = useState('')
  const [accountType, setAccountType] = useState<'apiKey' | 'chatgpt'>('chatgpt')
  const [chatgptSignInFlow, setChatgptSignInFlow] = useState<'browser' | 'deviceCode'>('browser')
  const [requesting, setRequesting] = useState(false)
  const [revealed, setRevealed] = useState(false)
  const mounted = useRef(true)
  const accountRef = useRef(account)
  accountRef.current = account
  const label = agentId === 'codex' ? 'Codex' : 'OpenCode'
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
    <section className="my-4 rounded border border-line p-4" aria-label={`${label} account for ${workspaceName}`}>
      <h3 className="font-medium">{label} account for {workspaceName}</h3>
      <div role="status" className="my-2 text-xs text-dim">
        {!account
          ? <p>Reading account…</p>
          : account.status === 'connected'
            ? agentId === 'codex'
              ? <button type="button" aria-pressed={revealed} title={revealed ? 'Hide email' : 'Reveal email'}
                  className={cn('cursor-pointer text-left transition-[filter] duration-150 focus-visible:outline focus-visible:outline-accent', !revealed && 'select-none blur-[3px]')}
                  onClick={() => setRevealed((value) => !value)}>
                  {account.accounts.join(', ')}
                </button>
              : <p>{account.accounts.join(', ')}</p>
            : <p>{account.status === 'signed-out' ? 'Signed out' : account.message}</p>}
        {account?.busy && <p>Active work in {workspaceName} must finish before changing accounts.</p>}
      </div>
      {agentId === 'codex' && !pending && <>
        <label className={field.wrap}>
          <span className={field.label}>Codex account type for {workspaceName}</span>
          <Select value={accountType} disabled={disabled} onChange={(event) => { setAccountType(event.target.value as typeof accountType); setApiKey('') }}>
            <option value="chatgpt">ChatGPT subscription</option>
            <option value="apiKey">API key</option>
          </Select>
        </label>
        {accountType === 'chatgpt' && <label className={field.wrap}>
          <span className={field.label}>ChatGPT sign-in flow for {workspaceName}</span>
          <Select value={chatgptSignInFlow} disabled={disabled} onChange={(event) => setChatgptSignInFlow(event.target.value as typeof chatgptSignInFlow)}>
            <option value="browser">Browser on this PC</option>
            <option value="deviceCode">One-time device code</option>
          </Select>
        </label>}
        {accountType === 'apiKey' && <label className={field.wrap}>
          <span className={field.label}>Codex API key for {workspaceName}</span>
          <input className={field.sized} type="password" autoComplete="off" spellCheck={false} value={apiKey}
            disabled={disabled} onChange={(event) => setApiKey(event.target.value)} />
        </label>}
        {accountType === 'chatgpt' && chatgptSignInFlow === 'deviceCode' && <p className="my-2 text-xs text-dim">Open the verification link from any device and enter the one-time code in the terminal panel. This signs Codex in with your ChatGPT subscription.</p>}
      </>}
      {agentId === 'opencode' && <p className="my-2 text-xs text-dim">Choose an API key or a subscription in the native provider prompts. Subscription availability depends on the provider.</p>}
      <div className="flex flex-wrap items-center gap-2">
        <button className={btn.primary} aria-label={`Connect ${label} for ${workspaceName}`}
          disabled={disabled || (agentId === 'codex' && accountType === 'apiKey' && !apiKey.trim())} onClick={connect}>Connect</button>
        {account?.status === 'connected' && <button className={btn.ghost} aria-label={`Disconnect ${label} for ${workspaceName}`}
          disabled={disabled} onClick={() => void run(() => window.anvil.accounts.disconnect(target))}>Disconnect</button>}
        <button className={btn.ghost} aria-label={`Refresh ${label} for ${workspaceName}`}
          disabled={requesting || pending} onClick={() => void run(() => window.anvil.accounts.status(target))}>Refresh</button>
        {pending && account.sessionId && <button className={btn.ghost} aria-label={`Cancel ${label} for ${workspaceName}`}
          onClick={() => void run(() => window.anvil.accounts.cancel({ ...target, sessionId: account.sessionId! }))}>Cancel</button>}
      </div>
      {pending && agentId === 'opencode' && <p className="mt-3 text-xs text-dim">Complete sign-in or sign-out in the terminal panel. Cancelling stops the command.</p>}
      {pending && account.terminalSessionId && <GhosttyTerminal key={account.terminalSessionId} sessionId={account.terminalSessionId} className="mt-3 h-[180px]" />}
    </section>
  )
}

export function WorkspaceAgentAccounts(): JSX.Element {
  const workspaceId = useStore((state) => state.activeWorkspaceId)
  const workspaceName = useStore((state) => state.workspaces.find((workspace) => workspace.id === workspaceId)?.name ?? 'Workspace')
  if (!workspaceId) return <p>Select a workspace to manage accounts.</p>
  return <div className="mt-6">
    <h2 className="font-medium">Accounts for {workspaceName}</h2>
    <p className="mt-1 text-xs text-dim">Account changes apply immediately to this workspace. Credentials stay in the agent's workspace profile.</p>
    {(['codex', 'opencode'] as const).map((agentId) => <AccountCard key={`${workspaceId}:${agentId}`} workspaceId={workspaceId} workspaceName={workspaceName} agentId={agentId} />)}
  </div>
}
