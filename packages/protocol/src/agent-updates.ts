export const UPDATABLE_AGENT_IDS = ['codex', 'claude'] as const

export type UpdatableAgentId = typeof UPDATABLE_AGENT_IDS[number]

export interface AgentUpdateState {
  agentId: UpdatableAgentId
  label: string
  installed: boolean
  currentVersion: string | null
  latestVersion: string | null
  available: boolean
  updating: boolean
  error: string | null
  checkedAt: number | null
}
