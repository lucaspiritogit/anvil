import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { decodeRpcInput } from '../shared/rpc-codec'

export interface HttpRuntime {
  invoke(channel: string, input?: unknown): unknown
  subscribeAll(listener: (channel: string, payload: unknown) => void): () => void
}

// 20 MiB of images expands to about 27 MiB in base64, plus prompt and metadata.
export const RPC_BODY_LIMIT = 32 * 1024 * 1024

class HttpError extends Error {
  constructor(readonly status: number, message: string) { super(message) }
}

export function isLoopbackAddress(address: string | undefined): boolean {
  return address === '127.0.0.1' || address === '::ffff:127.0.0.1'
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  if (!/^application\/json(?:;|$)/i.test(request.headers['content-type'] ?? '')) throw new HttpError(415, 'Expected application/json')
  if (Number(request.headers['content-length']) > RPC_BODY_LIMIT) throw new HttpError(413, 'RPC body too large')
  let size = 0
  const chunks: Buffer[] = []
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    size += chunk.length
    if (size > RPC_BODY_LIMIT) throw new HttpError(413, 'RPC body too large')
    chunks.push(chunk)
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) }
  catch { throw new HttpError(400, 'Invalid JSON body') }
}

export function createAnvilHttpServer(runtime: HttpRuntime, options: { version: string; rendererOrigin?: string }) {
  const clients = new Set<ServerResponse>()
  const unsubscribe = runtime.subscribeAll((channel, payload) => {
    const message = `data: ${JSON.stringify({ channel, payload })}\n\n`
    for (const client of clients) {
      client.write(message)
      // A single large event may exceed the stream high-water mark. Only drop
      // clients whose accumulated backlog would retain excessive memory.
      if (client.writableLength > 8 * 1024 * 1024) client.destroy()
    }
  })
  const server = createServer((request, response) => {
    const json = (status: number, value: unknown): void => {
      if (response.destroyed || response.headersSent) return
      response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
      response.end(JSON.stringify(value ?? null))
    }
    void (async () => {
      if (!isLoopbackAddress(request.socket.remoteAddress)) throw new HttpError(403, 'Loopback clients only')
      const address = server.address()
      const expectedHost = typeof address === 'object' && address ? `127.0.0.1:${address.port}` : ''
      if (request.headers.host !== expectedHost) throw new HttpError(403, 'Invalid Host header')
      const origin = request.headers.origin
      if (origin !== undefined) {
        if (origin !== 'null' && origin !== options.rendererOrigin) throw new HttpError(403, 'Origin not allowed')
        response.setHeader('Access-Control-Allow-Origin', origin)
        response.setHeader('Vary', 'Origin')
      }
      const path = request.url
      if (request.method === 'OPTIONS' && path === '/rpc') {
        response.writeHead(204, { 'Access-Control-Allow-Methods': 'POST', 'Access-Control-Allow-Headers': 'Content-Type' })
        response.end()
      } else if (request.method === 'GET' && path === '/health') {
        json(200, { ok: true, version: options.version })
      } else if (request.method === 'GET' && path === '/events') {
        response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' })
        response.write(': connected\n\n')
        clients.add(response)
        const heartbeat = setInterval(() => {
          response.write(': heartbeat\n\n')
          if (response.writableLength > 8 * 1024 * 1024) response.destroy()
        }, 15_000)
        response.on('close', () => { clients.delete(response); clearInterval(heartbeat) })
      } else if (request.method === 'POST' && path === '/rpc') {
        const body = await readBody(request)
        if (!body || typeof body !== 'object' || Array.isArray(body) || !('channel' in body) || typeof body.channel !== 'string' ||
          Object.keys(body).some((key) => key !== 'channel' && key !== 'input')) throw new HttpError(400, 'Expected { channel, input }')
        const input = decodeRpcInput(body.channel, 'input' in body ? body.input : undefined)
        json(200, await runtime.invoke(body.channel, input))
      } else {
        throw new HttpError(404, 'Not found')
      }
    })().catch((error: unknown) => {
      const message = error instanceof Error ? error.message : 'RPC failed'
      const status = error instanceof HttpError ? error.status : /^(Invalid |Unknown RPC channel)/.test(message) ? 400 : 500
      request.resume()
      json(status, { error: message })
    })
  })
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
      for (const client of clients) client.end()
      await new Promise<void>((resolve, reject) => server.close((error) => {
        if (error && (error as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING') reject(error)
        else resolve()
      }))
    }
  }
}
