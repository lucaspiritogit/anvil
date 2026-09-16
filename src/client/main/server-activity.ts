import { setTimeout as delay } from 'node:timers/promises'
import { networkInterfaces } from 'node:os'
import type { CaffeineActivity, CaffeineState } from '../../shared/caffeine'
import { isBrowserHostRequest, type BrowserHostRequest, type BrowserHostResponse } from '../../shared/browser-host'
import type { BrowserHost } from './server-process'

type CaffeineListener = (state: CaffeineState) => void

function parseCaffeineState(value: unknown): CaffeineState {
  if (!value || typeof value !== 'object' || !('keepAwake' in value) || typeof value.keepAwake !== 'boolean') {
    throw new Error('Invalid caffeine state from Anvil server')
  }
  return { keepAwake: value.keepAwake }
}

export function createServerCaffeineActivity(url: string, browserHost?: BrowserHost): CaffeineActivity {
  return {
    subscribe(listener) {
      const lifetime = new AbortController()
      void maintainCaffeineSubscription(url, listener, lifetime.signal, browserHost)
      return () => lifetime.abort()
    }
  }
}

async function maintainCaffeineSubscription(
  url: string,
  listener: CaffeineListener,
  signal: AbortSignal,
  browserHost?: BrowserHost
): Promise<void> {
  while (!signal.aborted) {
    try {
      await receiveCaffeineActivity(url, listener, signal, browserHost)
    } catch {
      // Retry after a server disconnect or a failed snapshot.
    } finally {
      if (!signal.aborted) listener({ keepAwake: false })
    }

    try {
      await delay(1_000, undefined, { signal })
    } catch {
      return
    }
  }
}

async function receiveCaffeineActivity(
  url: string,
  listener: CaffeineListener,
  lifetimeSignal: AbortSignal,
  browserHost?: BrowserHost
): Promise<void> {
  const connection = new AbortController()
  const signal = AbortSignal.any([lifetimeSignal, connection.signal])

  try {
    const response = await fetch(`${url}/events`, { signal })
    if (!response.ok || !response.body) {
      throw new Error('Could not subscribe to Anvil activity')
    }

    let receivedEvent = false
    if (browserHost) await post(url, 'browser-host:register', { addresses: Object.values(networkInterfaces()).flatMap((entries) =>
      (entries ?? []).filter((entry) => !entry.internal).map((entry) => entry.address)) }, signal)
    const events = readCaffeineEvents(response.body, signal, (state) => {
      receivedEvent = true
      listener(state)
    }, (request) => { void handleBrowserRequest(url, browserHost, request, signal) }).finally(() => connection.abort())

    const snapshot = fetchCaffeineSnapshot(url, signal).then((state) => {
      // Events received since subscribing take precedence over the initial snapshot.
      if (!signal.aborted && !receivedEvent) listener(state)
    })

    await Promise.all([events, snapshot])
  } finally {
    connection.abort()
  }
}

async function fetchCaffeineSnapshot(url: string, signal: AbortSignal): Promise<CaffeineState> {
  return parseCaffeineState(await post(url, 'app:caffeine', undefined, signal))
}

async function post(url: string, channel: string, input: unknown, signal: AbortSignal): Promise<unknown> {
  const response = await fetch(`${url}/rpc`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ channel, ...(input === undefined ? {} : { input }) }),
    signal: AbortSignal.any([signal, AbortSignal.timeout(5_000)])
  })
  if (!response.ok) {
    throw new Error('Could not read Anvil activity')
  }
  return response.json()
}

async function handleBrowserRequest(url: string, browserHost: BrowserHost | undefined, request: BrowserHostRequest, signal: AbortSignal): Promise<void> {
  let response: BrowserHostResponse
  try {
    if (!browserHost) throw new Error('The desktop browser host is unavailable')
    browserHost.setRemoteHost?.(new URL(url).hostname)
    if (request.operation === 'release') {
      browserHost.release(request.taskId)
      response = { type: 'anvil-browser-host-response', requestId: request.requestId, ok: true }
    } else {
      const connection = await browserHost.open(request.taskId, request.title)
      response = { type: 'anvil-browser-host-response', requestId: request.requestId, ok: true, connection }
    }
  } catch (error) {
    response = { type: 'anvil-browser-host-response', requestId: request.requestId, ok: false, error: error instanceof Error ? error.message : String(error) }
  }
  await post(url, 'browser-host:response', response, signal)
}

async function readCaffeineEvents(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  listener: CaffeineListener,
  browserListener: (request: BrowserHostRequest) => void
): Promise<void> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffered = ''

  try {
    while (!signal.aborted) {
      const chunk = await reader.read()
      if (chunk.done) break

      buffered += decoder.decode(chunk.value, { stream: true })
      let newline = buffered.indexOf('\n')
      while (newline !== -1) {
        const line = buffered.slice(0, newline).replace(/\r$/, '')
        buffered = buffered.slice(newline + 1)
        newline = buffered.indexOf('\n')

        // Anvil emits each event as one JSON data line, plus heartbeat comments.
        if (!line.startsWith('data:')) continue
        const event = JSON.parse(line.slice(5)) as { channel: string; payload: unknown }
        if (event.channel === 'app:caffeine' && !signal.aborted) listener(parseCaffeineState(event.payload))
        if (event.channel === 'browser-host:request' && isBrowserHostRequest(event.payload) && !signal.aborted) browserListener(event.payload)
      }
    }
  } finally {
    reader.releaseLock()
  }
}
