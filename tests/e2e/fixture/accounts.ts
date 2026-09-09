import type { AnvilApi } from '../../../src/preload'
import type { AgentAccountTarget, WorkspaceAgentAccount } from '../../../src/shared/types'

export function fixtureAccounts(name: (id: string) => string, busy: boolean): AnvilApi['accounts'] {
  const states = new Map<string, WorkspaceAgentAccount>()
  const listeners = new Set<(state: WorkspaceAgentAccount) => void>()
  const terminalData = new Map<string, string>()
  const key = (target: AgentAccountTarget): string => JSON.stringify([target.workspaceId, target.agentId])
  const current = (target: AgentAccountTarget): WorkspaceAgentAccount => states.get(key(target)) ?? {
    workspaceId: target.workspaceId, agentId: target.agentId, workspaceName: name(target.workspaceId), status: 'signed-out', accounts: [], busy
  }
  const publish = (state: WorkspaceAgentAccount): WorkspaceAgentAccount => {
    states.set(key(state), state)
    listeners.forEach((listener) => listener(state))
    return state
  }
  window.addEventListener('fixture:account-complete', (event) => {
    const { workspaceId, agentId, success } = (event as CustomEvent<AgentAccountTarget & { success: boolean }>).detail
    const state = current({ workspaceId, agentId })
    if (state.status !== 'pending') return
    publish({ ...state, status: success ? 'connected' : 'error', sessionId: undefined, terminal: false,
      accounts: success ? ['ChatGPT: fixture@example.test (plus)'] : [], message: success ? undefined : 'Sign-in failed. Retry the connection.' })
  })
  return {
    status: async (target) => current(target),
    onChanged: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    connect: async (input) => {
      const state = current(input)
      if (busy) return { ...state, status: 'busy', message: 'Wait for active work in this workspace.' }
      if (input.method === 'apiKey') {
        return publish({ ...state, status: input.apiKey === 'fixture-fail' ? 'error' : 'connected',
          accounts: input.apiKey === 'fixture-fail' ? [] : ['API key'], message: input.apiKey === 'fixture-fail' ? 'Account operation failed. Retry the connection.' : undefined })
      }
      const sessionId = crypto.randomUUID()
      terminalData.set(sessionId, 'Fake native provider login\r\nChoose api or subscription, then Enter. Type fail to simulate failure.\r\n')
      return publish({ ...state, status: 'pending', sessionId, terminal: input.agentId === 'opencode', message: 'Complete the native sign-in for this workspace.' })
    },
    cancel: async (input) => {
      const state = current(input)
      if (input.sessionId !== state.sessionId) return state
      terminalData.delete(input.sessionId)
      return publish({ ...state, status: 'cancelled', sessionId: undefined, terminal: false, message: 'Connection cancelled.' })
    },
    disconnect: async (target) => publish({ ...current(target), status: 'signed-out', accounts: [], sessionId: undefined, terminal: false }),
    terminal: async (input) => {
      const state = current(input)
      let data = terminalData.get(input.sessionId) ?? ''
      if (input.sessionId !== state.sessionId) return { data: '', sequence: 0 }
      if (input.data) {
        data += input.data
        terminalData.set(input.sessionId, data)
        if (input.data.includes('\r')) {
          const failed = data.includes('fail\r')
          publish({ ...state, status: failed ? 'error' : 'connected', sessionId: undefined, terminal: false,
            accounts: failed ? [] : [data.includes('subscription\r') ? 'OpenAI: subscription' : 'OpenAI: API key'], message: failed ? 'Native account command failed. Retry the connection.' : undefined })
          terminalData.delete(input.sessionId)
        }
      }
      return { data, sequence: data.length }
    }
  }
}
