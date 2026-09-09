import { useEffect, useRef, useState, type JSX } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import type { AgentAccountConnect, AgentAccountTarget, WorkspaceAgentAccount } from '@shared/types'
import { useStore } from '../state/store'
import { btn, field } from '../ui'

function AccountTerminal({ target, sessionId }: { target: AgentAccountTarget; sessionId: string }): JSX.Element {
  const host = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!host.current) return
    const terminal = new Terminal({ cols: 80, rows: 18, scrollback: 500, fontSize: 13, cursorBlink: true,
      theme: { background: '#0d0f12', foreground: '#d7dbe0' } })
    const fit = new FitAddon()
    terminal.loadAddon(fit)
    terminal.open(host.current)
    let disposed = false
    let reading = false
    let previous = ''
    let sequence = -1
    const refresh = async (): Promise<void> => {
      if (reading || disposed) return
      reading = true
      try {
        const snapshot = await window.anvil.accounts.terminal({ ...target, sessionId })
        if (disposed || snapshot.sequence === sequence) return
        if (snapshot.data.startsWith(previous)) terminal.write(snapshot.data.slice(previous.length))
        else { terminal.reset(); terminal.write(snapshot.data) }
        previous = snapshot.data
        sequence = snapshot.sequence
      } catch { /* Status controls report connection failures without echoing terminal input. */ }
      finally { reading = false }
    }
    const input = terminal.onData((data) => {
      void window.anvil.accounts.terminal({ ...target, sessionId, data }).catch(() => {})
    })
    const observer = new ResizeObserver(() => {
      if (!host.current?.clientWidth) return
      fit.fit()
      void window.anvil.accounts.terminal({ ...target, sessionId, cols: terminal.cols, rows: terminal.rows }).catch(() => {})
    })
    observer.observe(host.current)
    void refresh()
    const timer = setInterval(() => { void refresh() }, 200)
    terminal.focus()
    return () => { disposed = true; clearInterval(timer); observer.disconnect(); input.dispose(); terminal.dispose() }
  }, [target.workspaceId, target.agentId, sessionId])
  return <div ref={host} className="mt-3 h-72 overflow-hidden rounded border border-line bg-[#0d0f12] p-2" aria-label="Native provider login terminal" />
}

function AccountCard({ workspaceId, workspaceName, agentId }: AgentAccountTarget & { workspaceName: string }): JSX.Element {
  const [account, setAccount] = useState<WorkspaceAgentAccount | null>(null)
  const [apiKey, setApiKey] = useState('')
  const [method, setMethod] = useState<'apiKey' | 'chatgpt'>('chatgpt')
  const [requesting, setRequesting] = useState(false)
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
    const input: AgentAccountConnect = { ...target, method: agentId === 'opencode' ? 'native' : method,
      ...(agentId === 'codex' && method === 'apiKey' ? { apiKey } : {}) }
    setApiKey('')
    void run(() => window.anvil.accounts.connect(input))
  }
  const pending = account?.status === 'pending'
  const disabled = requesting || pending || account?.busy || !account
  return (
    <section className="my-4 rounded border border-line p-4" aria-label={`${label} account for ${workspaceName}`}>
      <h3 className="font-medium">{label} account for {workspaceName}</h3>
      <div role="status" className="my-2 text-xs text-dim">
        <p>{!account ? 'Reading account…' : account.status === 'connected' ? account.accounts.join(', ') : account.status === 'signed-out' ? 'Signed out' : account.message}</p>
        {account?.busy && <p>Active work in {workspaceName} must finish before changing accounts.</p>}
      </div>
      {agentId === 'codex' && !pending && <>
        <label className={field.wrap}>
          <span className={field.label}>Codex sign-in method for {workspaceName}</span>
          <select className={field.sized} value={method} disabled={disabled} onChange={(event) => { setMethod(event.target.value as typeof method); setApiKey('') }}>
            <option value="chatgpt">ChatGPT subscription</option>
            <option value="apiKey">API key</option>
          </select>
        </label>
        {method === 'apiKey' && <label className={field.wrap}>
          <span className={field.label}>Codex API key for {workspaceName}</span>
          <input className={field.sized} type="password" autoComplete="off" spellCheck={false} value={apiKey}
            disabled={disabled} onChange={(event) => setApiKey(event.target.value)} />
        </label>}
      </>}
      {agentId === 'opencode' && <p className="my-2 text-xs text-dim">Choose an API key or a subscription in the native provider prompts. Subscription availability depends on the provider.</p>}
      <div className="flex flex-wrap gap-2">
        <button className={btn.primary} disabled={disabled || (agentId === 'codex' && method === 'apiKey' && !apiKey.trim())} onClick={connect}>Connect {label} for {workspaceName}</button>
        <button className={btn.ghost} disabled={disabled} onClick={() => void run(() => window.anvil.accounts.disconnect(target))}>Disconnect {label} for {workspaceName}</button>
        <button className={btn.ghost} disabled={requesting || pending} onClick={() => void run(() => window.anvil.accounts.status(target))}>Refresh {label} for {workspaceName}</button>
        {pending && account.sessionId && <button className={btn.ghost} onClick={() => void run(() => window.anvil.accounts.cancel({ ...target, sessionId: account.sessionId! }))}>Cancel {label} for {workspaceName}</button>}
      </div>
      {pending && account.terminal && account.sessionId && <AccountTerminal target={target} sessionId={account.sessionId} />}
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
