import type { AnvilApi } from '../../../src/preload'
import type { AgentAccountTarget, WorkspaceAgentAccount } from '../../../src/shared/types'

export function fixtureAccounts(name: (id: string) => string, busy: boolean): AnvilApi['accounts'] {
  const states = new Map<string, WorkspaceAgentAccount>()
  const listeners = new Set<(state: WorkspaceAgentAccount) => void>()
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
    const { workspaceId, agentId, success, method } = (event as CustomEvent<AgentAccountTarget & { success: boolean; method?: string }>).detail
    const state = current({ workspaceId, agentId })
    if (state.status !== 'pending') return
    publish({ ...state, status: success ? 'connected' : 'error', sessionId: undefined,
      accounts: success ? [agentId === 'codex' ? 'ChatGPT: fixture@example.test (plus)' : method === 'api' ? 'OpenAI: API key' : 'OpenAI: subscription'] : [], message: success ? undefined : 'Sign-in failed. Retry the connection.' })
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
      return publish({ ...state, status: 'pending', sessionId, message: 'Complete the native sign-in for this workspace.' })
    },
    cancel: async (input) => {
      const state = current(input)
      if (input.sessionId !== state.sessionId) return state
      return publish({ ...state, status: 'cancelled', sessionId: undefined, message: 'Connection cancelled.' })
    },
    disconnect: async (target) => publish({ ...current(target), status: 'signed-out', accounts: [], sessionId: undefined })
  }
}
