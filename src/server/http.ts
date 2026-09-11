import { createAdaptorServer, type HttpBindings } from '@hono/node-server'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { decodeRpcInput } from '../shared/rpc-codec'

export interface HttpRuntime {
  invoke(channel: string, input?: unknown): unknown
  subscribeAll(listener: (channel: string, payload: unknown) => void): () => void
}

// 20 MiB of images expands to about 27 MiB in base64, plus prompt and metadata.
export const RPC_BODY_LIMIT = 32 * 1024 * 1024
const EVENT_BACKLOG_LIMIT = 8 * 1024 * 1024

interface EventClient {
  send(message: Uint8Array): void
  close(): void
}

export function isLoopbackAddress(address: string | undefined): boolean {
  return address === '127.0.0.1' || address === '::ffff:127.0.0.1'
}

async function readBody(request: Request): Promise<unknown> {
  if (!/^application\/json(?:;|$)/i.test(request.headers.get('content-type') ?? '')) {
    throw new HTTPException(415, { message: 'Expected application/json' })
  }
  if (Number(request.headers.get('content-length')) > RPC_BODY_LIMIT) {
    throw new HTTPException(413, { message: 'RPC body too large' })
  }
  let size = 0
  const chunks: Uint8Array[] = []
  const reader = request.body?.getReader()
  if (reader) {
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        size += value.byteLength
        if (size > RPC_BODY_LIMIT) throw new HTTPException(413, { message: 'RPC body too large' })
        chunks.push(value)
      }
    } finally {
      reader.releaseLock()
    }
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new HTTPException(400, { message: 'Invalid JSON body' })
  }
}

export function createAnvilHttpServer(runtime: HttpRuntime, options: { version: string; rendererOrigin?: string }) {
  const app = new Hono<{ Bindings: HttpBindings }>()
  const clients = new Set<EventClient>()
  const encoder = new TextEncoder()
  const unsubscribe = runtime.subscribeAll((channel, payload) => {
    const message = encoder.encode(`data: ${JSON.stringify({ channel, payload })}\n\n`)
    for (const client of clients) client.send(message)
  })

  app.use('*', async (context, next) => {
    context.header('Cache-Control', 'no-store')
    if (!isLoopbackAddress(context.env.incoming.socket.remoteAddress)) {
      throw new HTTPException(403, { message: 'Loopback clients only' })
    }
    const address = server.address()
    const expectedHost = typeof address === 'object' && address ? `127.0.0.1:${address.port}` : ''
    if (context.req.header('host') !== expectedHost) throw new HTTPException(403, { message: 'Invalid Host header' })
    const origin = context.req.header('origin')
    if (origin !== undefined) {
      if (origin !== 'null' && origin !== options.rendererOrigin) throw new HTTPException(403, { message: 'Origin not allowed' })
      context.header('Access-Control-Allow-Origin', origin)
      context.header('Vary', 'Origin')
    }
    // Keep the existing exact URL and method contract, including no HEAD fallback.
    if (context.env.incoming.url !== context.req.path || context.req.method === 'HEAD') {
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
    context.header('Access-Control-Allow-Headers', 'Content-Type')
    return context.body(null, 204)
  })
  app.get('/health', (context) => context.json({ ok: true, version: options.version }))
  app.get('/events', (context) => {
    let cleanup = (): void => {}
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        let closed = false
        const client: EventClient = {
          send(message) {
            if (closed) return
            controller.enqueue(message)
            const backlog = EVENT_BACKLOG_LIMIT - (controller.desiredSize ?? 0) + context.env.outgoing.writableLength
            if (backlog > EVENT_BACKLOG_LIMIT) {
              client.close()
              context.env.outgoing.destroy()
            }
          },
          close() {
            if (closed) return
            cleanup()
            controller.close()
          }
        }
        const heartbeat = setInterval(() => client.send(encoder.encode(': heartbeat\n\n')), 15_000)
        cleanup = () => {
          closed = true
          clients.delete(client)
          clearInterval(heartbeat)
          context.env.outgoing.off('close', client.close)
        }
        context.env.outgoing.once('close', client.close)
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
  app.post('/rpc', async (context) => {
    const body = await readBody(context.req.raw)
    if (!body || typeof body !== 'object' || Array.isArray(body) || !('channel' in body) || typeof body.channel !== 'string' ||
      Object.keys(body).some((key) => key !== 'channel' && key !== 'input')) {
      throw new HTTPException(400, { message: 'Expected { channel, input }' })
    }
    const input = decodeRpcInput(body.channel, 'input' in body ? body.input : undefined)
    const result = await runtime.invoke(body.channel, input)
    return context.json(result ?? null)
  })
  app.notFound((context) => context.json({ error: 'Not found' }, 404))
  app.onError((error, context) => {
    const status = error instanceof HTTPException ? error.status : /^(Invalid |Unknown RPC channel)/.test(error.message) ? 400 : 500
    context.env.incoming.resume()
    return context.json({ error: error.message }, status)
  })

  const server = createAdaptorServer({ fetch: app.fetch, overrideGlobalObjects: false })
  return {
    async listen(port = 4780): Promise<string> {
      if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid server port')
      await new Promise<void>((resolve, reject) => {
        const failed = (error: Error): void => { server.off('listening', ready); reject(error) }
        const ready = (): void => { server.off('error', failed); resolve() }
        server.once('error', failed)
        server.once('listening', ready)
        server.listen(port, '127.0.0.1')
      })
      const address = server.address()
      if (!address || typeof address === 'string' || address.address !== '127.0.0.1') throw new Error('Server must bind only to 127.0.0.1')
      return `http://127.0.0.1:${address.port}`
    },
    async close(): Promise<void> {
      unsubscribe()
      for (const client of clients) client.close()
      await new Promise<void>((resolve, reject) => server.close((error) => {
        if (error && (error as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING') reject(error)
        else resolve()
      }))
    }
  }
}
