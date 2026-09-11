import { setTimeout as delay } from 'node:timers/promises'
import type { CaffeineActivity, CaffeineState } from '../../shared/caffeine'

function caffeineState(value: unknown): CaffeineState {
  if (!value || typeof value !== 'object' || !('keepAwake' in value) || typeof value.keepAwake !== 'boolean') {
    throw new Error('Invalid caffeine state from Anvil server')
  }
  return { keepAwake: value.keepAwake }
}

/** Subscribe in main so sleep prevention does not depend on an open renderer window. */
export function createServerCaffeineActivity(url: string): CaffeineActivity {
  return {
    subscribe(listener) {
      const lifetime = new AbortController()
      const run = async (): Promise<void> => {
        while (!lifetime.signal.aborted) {
          const connection = new AbortController()
          const signal = AbortSignal.any([lifetime.signal, connection.signal])
          try {
            const response = await fetch(`${url}/events`, { signal })
            if (!response.ok || !response.body) throw new Error('Could not subscribe to Anvil activity')
            let receivedEvent = false
            const receiveEvents = async (): Promise<void> => {
              const reader = response.body!.getReader()
              const decoder = new TextDecoder()
              let buffered = ''
              try {
                while (!signal.aborted) {
                  const chunk = await reader.read()
                  if (chunk.done) break
                  buffered += decoder.decode(chunk.value, { stream: true })
                  let newline: number
                  while ((newline = buffered.indexOf('\n')) !== -1) {
                    const line = buffered.slice(0, newline).replace(/\r$/, '')
                    buffered = buffered.slice(newline + 1)
                    // Anvil emits each event as one JSON data line, plus heartbeat comments.
                    if (!line.startsWith('data:')) continue
                    const event = JSON.parse(line.slice(5)) as { channel: string; payload: unknown }
                    if (event.channel !== 'app:caffeine') continue
                    receivedEvent = true
                    if (!signal.aborted) listener(caffeineState(event.payload))
                  }
                }
              } finally {
                reader.releaseLock()
                connection.abort()
              }
            }
            const loadSnapshot = async (): Promise<void> => {
              const snapshot = await fetch(`${url}/rpc`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ channel: 'app:caffeine' }),
                signal: AbortSignal.any([signal, AbortSignal.timeout(5_000)])
              })
              if (!snapshot.ok) throw new Error('Could not read Anvil activity')
              const state = caffeineState(await snapshot.json())
              // An event received since subscribing is at least as fresh as the snapshot.
              if (!signal.aborted && !receivedEvent) listener(state)
            }
            await Promise.all([receiveEvents(), loadSnapshot()])
          } catch {
            // Reconnect below, including after server restart or a failed snapshot.
          } finally {
            connection.abort()
            if (!lifetime.signal.aborted) listener({ keepAwake: false })
          }
          try { await delay(1_000, undefined, { signal: lifetime.signal }) }
          catch { return }
        }
      }
      void run()
      return () => lifetime.abort()
    }
  }
}
