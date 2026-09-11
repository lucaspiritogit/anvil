import type { IpcChannel, IpcRequests } from '../shared/ipc-requests'
import { validateIpcRequest } from './handlers/validation'

export interface HandlerRegistry {
  handle<C extends IpcChannel>(channel: C, listener: (input: IpcRequests[C], context: HandlerContext) => unknown): void
  on<C extends IpcChannel>(channel: C, listener: (input: IpcRequests[C], context: HandlerContext) => unknown): void
}

export interface HandlerContext {
  deferUntilResponse(action: () => void | Promise<void>): void
}

export function createHandlerRegistry() {
  const handlers = new Map<string, (input: never, context: HandlerContext) => unknown>()
  const handle: HandlerRegistry['handle'] = (channel, listener) => {
    if (handlers.has(channel)) throw new Error(`Duplicate handler: ${channel}`)
    handlers.set(channel, listener)
  }
  return {
    handle,
    on: handle,
    channels: (): string[] => [...handlers.keys()],
    invoke(channel: string, input?: unknown, context?: HandlerContext): unknown {
      const handler = handlers.get(channel)
      if (!handler) throw new Error(`Unknown RPC channel: ${channel}`)
      const validated = validateIpcRequest(channel as IpcChannel, [input]) as never
      const handlerContext = context ?? {
        deferUntilResponse: (action) => { setImmediate(() => { void action() }) }
      }
      return handler.length >= 2 ? handler(validated, handlerContext) : (handler as (input: never) => unknown)(validated)
    }
  }
}
