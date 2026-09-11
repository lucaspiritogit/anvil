import { encodeRpcInput } from '../../shared/rpc-codec'
import type { IpcArgs, IpcInvokeChannel } from '../../shared/ipc-requests'

export function createHttpClient(url: string, onReady: () => void, onFailure: (message: string) => void) {
  const terminalRequests = new Map<string, Promise<unknown>>()
  const listeners = new Map<string, Set<(payload: unknown) => void>>()
  const events = new EventSource(`${url}/events`)
  let disposed = false
  events.onopen = () => {
    void fetch(`${url}/health`).then(async (response) => {
      const health = await response.json() as { ok?: boolean }
      if (!response.ok || health.ok !== true) throw new Error('Anvil server is unavailable')
      if (!disposed && events.readyState === EventSource.OPEN) onReady()
    }).catch((error: Error) => onFailure(error.message))
  }
  events.onerror = () => onFailure('Disconnected from Anvil server. Reconnecting…')
  events.onmessage = (event) => {
    const { channel, payload } = JSON.parse(event.data) as { channel: string; payload: unknown }
    for (const listener of listeners.get(channel) ?? []) listener(payload)
  }
  const post = async <T>(channel: IpcInvokeChannel, input: unknown): Promise<T> => {
    const response = await fetch(`${url}/rpc`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel, input: encodeRpcInput(channel, input) })
    })
    const result = await response.json()
    if (!response.ok) throw new Error(result.error ?? `Anvil request failed (${response.status})`)
    return result as T
  }
  return {
    invoke<C extends IpcInvokeChannel, T>(channel: C, ...args: IpcArgs<C>): Promise<T> {
      const input = args[0]
      if ((channel === 'terminals:write' || channel === 'terminals:resize') && input && typeof input === 'object' && 'sessionId' in input) {
        const sessionId = input.sessionId
        // Preserve the ordering that Electron send previously gave terminal keystrokes.
        const previous = terminalRequests.get(sessionId) ?? Promise.resolve()
        const pending = previous.then(() => post<T>(channel, input))
        const settled = pending.then(() => {}, () => {})
        terminalRequests.set(sessionId, settled)
        void settled.then(() => { if (terminalRequests.get(sessionId) === settled) terminalRequests.delete(sessionId) })
        return pending
      }
      return post<T>(channel, input)
    },
    subscribe<T>(channel: string, listener: (payload: T) => void): () => void {
      let subscriptions = listeners.get(channel)
      if (!subscriptions) { subscriptions = new Set(); listeners.set(channel, subscriptions) }
      const receive = (payload: unknown): void => listener(payload as T)
      subscriptions.add(receive)
      return () => { subscriptions.delete(receive) }
    },
    close(): void {
      disposed = true
      events.close()
      listeners.clear()
    }
  }
}
