import { EventEmitter } from 'node:events'
import type { BrowserHostRequest, BrowserHostResponse } from '../shared/browser-host'
import type { BrowserHostTransport } from './browser-host-client'

export class RemoteBrowserHostTransport extends EventEmitter implements BrowserHostTransport {
  connected = false
  private remoteAddress?: string

  constructor(private readonly dispatch: (request: BrowserHostRequest) => void) {
    super()
  }

  register(remoteAddress: string | undefined, advertisedAddresses: string[] = []): void {
    const observed = remoteAddress?.startsWith('::ffff:') ? remoteAddress.slice(7) : remoteAddress
    const observedIsLoopback = observed === '127.0.0.1' || observed === '::1'
    const advertised = advertisedAddresses.find((address) => address.startsWith('100.')) ?? advertisedAddresses[0]
    const address = observed && !observedIsLoopback ? observed : advertised
    if (!address) return
    this.remoteAddress = address
    this.connected = true
  }

  send(message: BrowserHostRequest, callback?: (error: Error | null) => void): boolean {
    if (!this.connected) {
      callback?.(new Error('The desktop browser host is unavailable'))
      return false
    }
    this.dispatch(message)
    callback?.(null)
    return true
  }

  receive(response: BrowserHostResponse, remoteAddress: string | undefined): void {
    this.register(remoteAddress)
    if (response.ok && response.connection && this.remoteAddress) {
      const url = new URL(response.connection.url)
      url.hostname = this.remoteAddress.includes(':') ? `[${this.remoteAddress}]` : this.remoteAddress
      response = { ...response, connection: { ...response.connection, url: url.toString() } }
    }
    this.emit('message', response)
  }

  close(): void {
    this.connected = false
    this.removeAllListeners()
  }
}
