import type { IpcChannel, IpcRequests } from '../shared/ipc-requests'
import { validateIpcRequest } from './handlers/validation'

export interface HandlerRegistry {
  handle<C extends IpcChannel>(channel: C, listener: (input: IpcRequests[C]) => unknown): void
  on<C extends IpcChannel>(channel: C, listener: (input: IpcRequests[C]) => unknown): void
}

export function createHandlerRegistry() {
  const handlers = new Map<string, (input: never) => unknown>()
  const handle: HandlerRegistry['handle'] = (channel, listener) => {
    if (handlers.has(channel)) throw new Error(`Duplicate handler: ${channel}`)
    handlers.set(channel, listener)
  }
  return {
    handle,
    on: handle,
    channels: (): string[] => [...handlers.keys()],
    invoke(channel: string, input?: unknown): unknown {
      const handler = handlers.get(channel)
      if (!handler) throw new Error(`Unknown RPC channel: ${channel}`)
      return handler(validateIpcRequest(channel as IpcChannel, [input]) as never)
    }
  }
}
