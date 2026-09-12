import { serve, type HttpBindings, type ServerType } from '@hono/node-server'
import { getConnInfo } from '@hono/node-server/conninfo'
import { serveStatic } from '@hono/node-server/serve-static'
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { HTTPException } from 'hono/http-exception'
import { decodeRpcInput } from '../shared/rpc-codec'
import type { HandlerContext } from './handler-registry'

export interface HttpRuntime {
  invoke(channel: string, input?: unknown, context?: HandlerContext): unknown
  subscribeAll(listener: (channel: string, payload: unknown) => void): () => void
}

export interface HttpServerAuth {
  verifyPassword(candidate: string): Promise<boolean>
}

// 20 MiB of images expands to about 27 MiB in base64, plus prompt and metadata.
export const RPC_BODY_LIMIT = 32 * 1024 * 1024
const EVENT_BACKLOG_LIMIT = 8 * 1024 * 1024

interface EventClient {
  send(message: Uint8Array): void
  close(): void
}

export function isLoopbackAddress(address: string | undefined): boolean {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

function expectedHost(address: string | undefined, port: number | undefined): string {
  if (!address || !port) return ''
  const normalized = address.startsWith('::ffff:') ? address.slice('::ffff:'.length) : address
  return normalized.includes(':') ? `[${normalized}]:${port}` : `${normalized}:${port}`
}

async function authorized(header: string | undefined, auth: HttpServerAuth | undefined): Promise<boolean> {
  const match = /^Basic ([A-Za-z0-9+/]+={0,2})$/.exec(header ?? '')
  if (!match || !auth) return false
  let decoded: string
  try {
    decoded = Buffer.from(match[1], 'base64').toString('utf8')
  } catch {
    return false
  }
  const separator = decoded.indexOf(':')
  return separator !== -1 && decoded.slice(0, separator) === 'anvil'
    && auth.verifyPassword(decoded.slice(separator + 1))
}

export function createAnvilHttpServer(runtime: HttpRuntime, options: {
  version: string
  rendererOrigin?: string
  rendererDirectory?: string
  auth?: HttpServerAuth
  requireAuthentication?: boolean
  externalOrigin?: string
  isReady?(): boolean
}) {
  const app = new Hono<{ Bindings: HttpBindings }>()
  const clients = new Set<EventClient>()
  const encoder = new TextEncoder()
  let boundPort: number | undefined
  let boundHost: '127.0.0.1' | '0.0.0.0' | undefined
  let server: ServerType | undefined
  const unsubscribe = runtime.subscribeAll((channel, payload) => {
    const message = encoder.encode(`data: ${JSON.stringify({ channel, payload })}\n\n`)
    for (const client of clients) client.send(message)
  })

  app.use('*', async (context, next) => {
    const requestServer = server
    context.env.outgoing.once('finish', () => {
      // SSE responses finish after close() has swept idle connections. Close
      // those newly idle sockets too, so they do not delay the next listener.
      if (requestServer && !requestServer.listening && 'closeIdleConnections' in requestServer) {
        requestServer.closeIdleConnections()
      }
    })
    context.header('Cache-Control', 'no-store')
    if ((options.requireAuthentication || !isLoopbackAddress(getConnInfo(context).remote.address)) &&
      !await authorized(context.req.header('authorization'), options.auth)) {
      context.header('WWW-Authenticate', 'Basic realm="Anvil", charset="UTF-8"')
      throw new HTTPException(401, { message: 'Authentication required' })
    }
    const socket = context.env.incoming.socket
    const host = context.req.header('host')
    const externalHost = options.externalOrigin ? new URL(options.externalOrigin).host : undefined
    if (host !== expectedHost(socket.localAddress, socket.localPort) && (!externalHost || host !== externalHost)) {
      throw new HTTPException(403, { message: 'Invalid Host header' })
    }
    const origin = context.req.header('origin')
    if (origin !== undefined) {
      const sameOrigin = options.externalOrigin ?? new URL(context.req.url).origin
      if (origin !== sameOrigin && (options.externalOrigin || (origin !== 'null' && origin !== options.rendererOrigin))) {
        throw new HTTPException(403, { message: 'Origin not allowed' })
      }
      context.header('Access-Control-Allow-Origin', origin)
      context.header('Vary', 'Origin')
    }
    // Keep the existing exact URL and method contract, including no HEAD fallback.
    if (new URL(context.req.url).search !== '' || context.req.method === 'HEAD') {
      throw new HTTPException(404, { message: 'Not found' })
    }
    try {
      await next()
    } catch (error) {
      throw error instanceof Error ? error : new Error('RPC failed')
    }
  })

  app.options('/rpc', (context) => {
    context.header('Access-Control-Allow-Methods', 'POST')
    context.header('Access-Control-Allow-Headers', 'Authorization, Content-Type')
    return context.body(null, 204)
  })
  app.get('/health', (context) => context.json({
    ok: true,
    service: 'anvil',
    version: options.version,
    ready: options.isReady?.() ?? true
  }))
  app.get('/events', (context) => {
    let cleanup = (): void => {}
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        let closed = false
        const client: EventClient = {
          send(message) {
            if (closed) return
            controller.enqueue(message)
            const backlog = EVENT_BACKLOG_LIMIT - (controller.desiredSize ?? 0)
            if (backlog > EVENT_BACKLOG_LIMIT) client.close()
          },
          close() {
            if (closed) return
            cleanup()
            try {
              controller.close()
            } catch {
              return
            }
          }
        }
        const heartbeat = setInterval(() => client.send(encoder.encode(': heartbeat\n\n')), 15_000)
        cleanup = () => {
          closed = true
          clients.delete(client)
          clearInterval(heartbeat)
          context.req.raw.signal.removeEventListener('abort', client.close)
        }
        context.req.raw.signal.addEventListener('abort', client.close)
        clients.add(client)
        client.send(encoder.encode(': connected\n\n'))
      },
      cancel() {
        cleanup()
      }
    }, new ByteLengthQueuingStrategy({ highWaterMark: EVENT_BACKLOG_LIMIT }))
    context.header('Content-Type', 'text/event-stream')
    context.header('Cache-Control', 'no-cache')
    context.header('Connection', 'keep-alive')
    context.header('X-Accel-Buffering', 'no')
    return context.body(body)
  })
  app.post(
    '/rpc',
    bodyLimit({ maxSize: RPC_BODY_LIMIT, onError: (context) => context.json({ error: 'RPC body too large' }, 413) }),
    async (context) => {
      const type = context.req.header('content-type') ?? ''
      if (!/^application\/json(?:;|$)/i.test(type)) {
        throw new HTTPException(415, { message: 'Expected application/json' })
      }
      let body: unknown
      try {
        body = await context.req.json()
      } catch {
        throw new HTTPException(400, { message: 'Invalid JSON body' })
      }
      if (!body || typeof body !== 'object' || Array.isArray(body) || !('channel' in body) || typeof body.channel !== 'string' ||
        Object.keys(body).some((key) => key !== 'channel' && key !== 'input')) {
        throw new HTTPException(400, { message: 'Expected { channel, input }' })
      }
      const input = decodeRpcInput(body.channel, 'input' in body ? body.input : undefined)
      const deferred: Array<() => void | Promise<void>> = []
      const result = await runtime.invoke(body.channel, input, {
        deferUntilResponse: (action) => { deferred.push(action) }
      })
      if (deferred.length) {
        context.env.outgoing.once('finish', () => {
          for (const action of deferred) Promise.resolve().then(action).catch((error) => {
            console.error('Deferred HTTP action failed:', error)
          })
        })
      }
      return context.json(result ?? null)
    }
  )
  if (options.rendererDirectory) {
    app.get('/', serveStatic({ root: options.rendererDirectory, path: 'index.html' }))
    app.get('/assets/*', serveStatic({ root: options.rendererDirectory }))
  }
  app.notFound((context) => context.json({ error: 'Not found' }, 404))
  app.onError((error, context) => {
    const status = error instanceof HTTPException ? error.status : /^(Invalid |Unknown RPC channel)/.test(error.message) ? 400 : 500
    return context.json({ error: error.message }, status)
  })

  let operations = Promise.resolve()
  let closed = false

  const start = async (port: number, host: '127.0.0.1' | '0.0.0.0'): Promise<number> => {
    await new Promise<void>((resolve, reject) => {
      const failed = (error: Error): void => { reject(error) }
      server = serve({ fetch: app.fetch, port, hostname: host, overrideGlobalObjects: false }, (info) => {
        server?.off('error', failed)
        if (info.address !== host) {
          reject(new Error(`Server did not bind to ${host}`))
          return
        }
        resolve()
      })
      server.once('error', failed)
    })
    const address = server?.address()
    if (!address || typeof address === 'string' || address.address !== host) {
      throw new Error(`Server did not bind to ${host}`)
    }
    boundPort = address.port
    boundHost = host
    return address.port
  }
  const stop = async (): Promise<void> => {
    for (const client of [...clients]) client.close()
    const active = server
    if (!active) {
      boundHost = undefined
      return
    }
    await new Promise<void>((resolve, reject) => active.close((error) => {
      if (error && (error as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING') reject(error)
      else resolve()
    }))
    boundHost = undefined
  }
  const serialize = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = operations.then(operation, operation)
    operations = result.then(() => {}, () => {})
    return result
  }

  return {
    async listen(port = 4780): Promise<string> {
      if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid server port')
      return serialize(async () => {
        if (closed || boundHost) throw new Error('Server is already listening or closed')
        const actualPort = await start(port, '127.0.0.1')
        return `http://127.0.0.1:${actualPort}`
      })
    },
    async rebind(allowOtherDevices: boolean): Promise<void> {
      return serialize(async () => {
        if (closed || boundPort === undefined || boundHost === undefined) throw new Error('Server is not listening')
        const target = allowOtherDevices ? '0.0.0.0' : '127.0.0.1'
        if (boundHost === target) return
        const port = boundPort
        await stop()
        try {
          await start(port, target)
        } catch (error) {
          if (target === '0.0.0.0') {
            try {
              await start(port, '127.0.0.1')
            } catch (rollbackError) {
              throw new AggregateError([error, rollbackError], 'Could not enable LAN access or restore loopback access')
            }
          }
          throw error
        }
      })
    },
    async close(): Promise<void> {
      return serialize(async () => {
        if (closed) return
        closed = true
        unsubscribe()
        await stop()
      })
    }
  }
}
