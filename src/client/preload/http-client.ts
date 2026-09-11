import { encodeRpcInput } from '../../shared/rpc-codec'
import type { IpcArgs, IpcInvokeChannel, IpcRequests } from '../../shared/ipc-requests'

type TerminalRequest = (
  | { channel: 'terminals:write'; input: IpcRequests['terminals:write'] }
  | { channel: 'terminals:resize'; input: IpcRequests['terminals:resize'] }
) & {
  callbacks: Array<{ resolve(value: unknown): void; reject(error: unknown): void }>
}

const TERMINAL_WRITE_LIMIT = 65536

export function createHttpClient(url: string, onReady: () => void, onFailure: (message: string) => void) {
  const terminalRequests = new Map<string, TerminalRequest[]>()
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
  const drainTerminalRequests = async (sessionId: string, queue: TerminalRequest[]): Promise<void> => {
    while (queue.length > 0) {
      // Remove the in-flight request so new input only joins unsent writes.
      const request = queue.shift()!
      try {
        const result = await post(request.channel, request.input)
        for (const callback of request.callbacks) callback.resolve(result)
      } catch (error) {
        for (const callback of request.callbacks) callback.reject(error)
      }
    }
    terminalRequests.delete(sessionId)
  }
  return {
    invoke<C extends IpcInvokeChannel, T>(channel: C, ...args: IpcArgs<C>): Promise<T> {
      const input = args[0]
      if ((channel === 'terminals:write' || channel === 'terminals:resize') && input && typeof input === 'object' && 'sessionId' in input) {
        const sessionId = input.sessionId
        return new Promise<T>((resolve, reject) => {
          const callback = { resolve: (value: unknown) => resolve(value as T), reject }
          let queue = terminalRequests.get(sessionId)
          const running = queue !== undefined
          if (!queue) {
            queue = []
            terminalRequests.set(sessionId, queue)
          }
          const last = queue[queue.length - 1]
          if (channel === 'terminals:write' && 'data' in input) {
            // A slow round trip must not become one round trip per queued key.
            // Keep resize boundaries and the server's per-write size limit.
            if (last?.channel === 'terminals:write' && last.input.data.length + input.data.length <= TERMINAL_WRITE_LIMIT) {
              last.input.data += input.data
              last.callbacks.push(callback)
            } else {
              queue.push({ channel, input: { sessionId, data: input.data }, callbacks: [callback] })
            }
          } else if (channel === 'terminals:resize' && 'cols' in input && 'rows' in input) {
            queue.push({ channel, input: { sessionId, cols: input.cols, rows: input.rows }, callbacks: [callback] })
          } else {
            reject(new Error('Invalid terminal request'))
          }
          if (!running) void drainTerminalRequests(sessionId, queue)
        })
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
