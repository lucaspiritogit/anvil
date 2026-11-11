import { useEffect, useRef, useState } from 'react'
import type { AgentUpdateState, UpdatableAgentId } from '@anvil/protocol/agent-updates'
import { dismissToast, showToast } from '../state/toasts'
import { useUpdatePreferences } from '../state/update-preferences'

export const AGENT_UPDATE_CHECK_INTERVAL_MS = 60 * 60_000
const SNOOZED_STORAGE_KEY = 'anvil:agent-updates-snoozed'

type Snoozed = Partial<Record<UpdatableAgentId, string>>

export function agentUpdateToastId(agentId: UpdatableAgentId): string {
  return `anvil-agent-update-${agentId}`
}

function readSnoozed(): Snoozed {
  try {
    const stored: unknown = JSON.parse(window.localStorage.getItem(SNOOZED_STORAGE_KEY) ?? '{}')
    return stored && typeof stored === 'object' && !Array.isArray(stored) ? stored as Snoozed : {}
  } catch {
    return {}
  }
}

function writeSnoozed(value: Snoozed): void {
  try { window.localStorage.setItem(SNOOZED_STORAGE_KEY, JSON.stringify(value)) } catch {}
}

function installAgentUpdate(agent: AgentUpdateState): void {
  void window.anvil.agents.updates.install(agent.agentId).catch((error: unknown) => {
    showToast({
      id: agentUpdateToastId(agent.agentId),
      title: `${agent.label} could not be updated`,
      body: error instanceof Error ? error.message : String(error),
      persistent: true
    })
  })
}

export function AgentUpdateNotifier(): null {
  const enabled = useUpdatePreferences((s) => s.checksEnabled)
  const [agents, setAgents] = useState<AgentUpdateState[]>([])
  const [snoozed, setSnoozed] = useState<Snoozed>(readSnoozed)
  const shown = useRef<Partial<Record<UpdatableAgentId, 'notice' | 'progress'>>>({})
  const previous = useRef<Snoozed>({})

  useEffect(() => {
    if (!enabled) {
      setAgents([])
      return
    }
    let active = true
    const host = window.anvil.agents.updates
    const stop = host.onChanged((states) => { if (active) setAgents(states) })
    const check = (): void => {
      if (!navigator.onLine) return
      void host.check().then((states) => { if (active) setAgents(states) }).catch((error: unknown) => {
        console.warn('Could not check for agent updates:', error)
      })
    }
    check()
    const timer = window.setInterval(check, AGENT_UPDATE_CHECK_INTERVAL_MS)
    return () => {
      active = false
      stop()
      window.clearInterval(timer)
    }
  }, [enabled])

  useEffect(() => {
    const snooze = (agent: AgentUpdateState): void => setSnoozed((current) => {
      const next = { ...current, [agent.agentId]: agent.latestVersion ?? '' }
      writeSnoozed(next)
      return next
    })
    for (const agent of agents) {
      const id = agentUpdateToastId(agent.agentId)
      const kind = shown.current[agent.agentId]
      const hidden = snoozed[agent.agentId] === agent.latestVersion
      if (agent.updating) {
        if (kind !== 'progress') previous.current[agent.agentId] = agent.currentVersion ?? ''
        shown.current[agent.agentId] = 'progress'
        showToast({ id, title: `Updating ${agent.label}…`, body: 'Tasks that are already running keep their current version.', persistent: true, dismissible: false })
      } else if (agent.error && agent.available && (kind === 'progress' || !hidden)) {
        shown.current[agent.agentId] = 'notice'
        showToast({
          id,
          title: `${agent.label} could not be updated`,
          body: agent.error,
          persistent: true,
          actions: [
            { label: 'Try again', onClick: () => installAgentUpdate(agent), dismiss: false },
            { label: 'Later', onClick: () => snooze(agent) }
          ]
        })
      } else if (kind === 'progress') {
        delete shown.current[agent.agentId]
        if (agent.currentVersion && agent.currentVersion !== previous.current[agent.agentId]) {
          showToast({ id, title: `${agent.label} updated to ${agent.currentVersion}`, body: 'New tasks use the updated version.' })
        } else {
          showToast({ id, title: `${agent.label} is up to date`, body: agent.currentVersion ? `Version ${agent.currentVersion} is the latest for this install.` : undefined })
        }
      } else if (agent.available && agent.latestVersion && !hidden) {
        shown.current[agent.agentId] = 'notice'
        showToast({
          id,
          title: `${agent.label} ${agent.latestVersion} is available`,
          body: `Version ${agent.currentVersion} is installed on the machine running Anvil.`,
          persistent: true,
          actions: [
            { label: 'Update', onClick: () => installAgentUpdate(agent), dismiss: false },
            { label: 'Later', onClick: () => snooze(agent) }
          ]
        })
      } else if (kind === 'notice') {
        delete shown.current[agent.agentId]
        dismissToast(id)
      }
    }
  }, [agents, snoozed])

  return null
}
