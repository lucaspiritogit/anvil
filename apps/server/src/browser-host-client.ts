import { randomUUID } from 'node:crypto'
import type { BrowserHostRequest, BrowserHostResponse, BrowserToolConnectionData } from '@anvil/protocol/browser-host'
import { isBrowserHostResponse } from '@anvil/protocol/browser-host'

export interface BrowserHostTransport {
  connected?: boolean
  send?(message: BrowserHostRequest, callback?: (error: Error | null) => void): boolean
  on(event: 'message', listener: (message: unknown) => void): unknown
  off(event: 'message', listener: (message: unknown) => void): unknown
}

export interface BrowserCapabilityConnection extends BrowserToolConnectionData {
  close(): Promise<void>
}

interface PendingRequest {
  resolve(response: BrowserHostResponse): void
  reject(error: Error): void
  timeout: NodeJS.Timeout
}

type BrowserHostRequestInput =
  | { operation: 'open'; taskId: string; title: string }
  | { operation: 'release'; taskId: string }

export class BrowserHostClient {
  private readonly pending = new Map<string, PendingRequest>()
  private closed = false

  constructor(private readonly transport: BrowserHostTransport) {
    this.transport.on('message', this.receive)
  }

  private readonly receive = (message: unknown): void => {
    if (!isBrowserHostResponse(message)) return
    const pending = this.pending.get(message.requestId)
    if (!pending) return
    this.pending.delete(message.requestId)
    clearTimeout(pending.timeout)
    if (message.ok) pending.resolve(message)
    else pending.reject(new Error(message.error))
  }

  private request(request: BrowserHostRequestInput): Promise<BrowserHostResponse> {
    if (this.closed || !this.transport.send || this.transport.connected === false) return Promise.reject(new Error('The desktop browser host is unavailable'))
    const requestId = randomUUID()
    const message = { ...request, type: 'anvil-browser-host-request', requestId } as BrowserHostRequest
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(requestId)
        reject(new Error('The desktop browser host did not respond'))
      }, 10_000)
      this.pending.set(requestId, { resolve, reject, timeout })
      try {
        this.transport.send?.(message, (error) => {
          if (!error) return
          const pending = this.pending.get(requestId)
          if (!pending) return
          this.pending.delete(requestId)
          clearTimeout(pending.timeout)
          reject(error)
        })
      } catch (error) {
        this.pending.delete(requestId)
        clearTimeout(timeout)
        reject(error)
      }
    })
  }

  async open(taskId: string, title: string): Promise<BrowserCapabilityConnection> {
    const response = await this.request({ operation: 'open', taskId, title })
    if (!response.ok || !response.connection) throw new Error('The desktop browser host returned no connection')
    let released = false
    return {
      ...response.connection,
      close: async () => {
        if (released) return
        released = true
        await this.request({ operation: 'release', taskId }).then(() => {}, () => {})
      }
    }
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.transport.off('message', this.receive)
    for (const request of this.pending.values()) {
      clearTimeout(request.timeout)
      request.reject(new Error('The desktop browser host closed'))
    }
    this.pending.clear()
  }
}
