import { randomBytes } from 'node:crypto'
import { createAdaptorServer, type HttpBindings, type ServerType } from '@hono/node-server'
import { Hono } from 'hono'
import type { Tool } from '@modelcontextprotocol/sdk/types.js'
import type { BrowserToolConnectionData } from '@anvil/protocol/browser-host'
import type { BrowserSessionManager } from './browser-sessions'

interface BrowserToolOwner {
  taskId: string
  title: string
  active: boolean
  turn: number
}

const selector = { type: 'string', description: 'CSS selector from browser_snapshot.' }

export const BROWSER_TOOLS: Tool[] = [
  { name: 'browser_open', description: 'Open a loopback HTTP or HTTPS URL in the browser pane beside Anvil task output.', inputSchema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'], additionalProperties: false } },
  { name: 'browser_snapshot', description: 'Read the current page URL, title, visible text and interactive elements.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'browser_screenshot', description: 'Capture the current visible browser viewport as PNG.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'browser_click', description: 'Click an element by CSS selector or viewport coordinates.', inputSchema: { type: 'object', properties: { selector, x: { type: 'number' }, y: { type: 'number' } }, additionalProperties: false } },
  { name: 'browser_type', description: 'Replace the value of an input, textarea or contenteditable element.', inputSchema: { type: 'object', properties: { selector, text: { type: 'string' } }, required: ['selector', 'text'], additionalProperties: false } },
  { name: 'browser_press', description: 'Send one supported key to the current page.', inputSchema: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'], additionalProperties: false } },
  { name: 'browser_scroll', description: 'Scroll the current page by pixel deltas.', inputSchema: { type: 'object', properties: { deltaX: { type: 'number' }, deltaY: { type: 'number' } }, required: ['deltaX', 'deltaY'], additionalProperties: false } },
  { name: 'browser_evaluate', description: 'Evaluate JavaScript in the current page and return a JSON-compatible result.', inputSchema: { type: 'object', properties: { expression: { type: 'string' } }, required: ['expression'], additionalProperties: false } },
  { name: 'browser_viewport', description: 'Switch the browser between desktop 1280x800 and mobile 390x844.', inputSchema: { type: 'object', properties: { viewport: { type: 'string', enum: ['desktop', 'mobile'] } }, required: ['viewport'], additionalProperties: false } },
  { name: 'browser_close', description: 'Close this task\'s visible agent browser.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } }
]

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected an object')
  return value as Record<string, unknown>
}

function exactArguments(name: string, input: unknown): Record<string, unknown> {
  const definition = BROWSER_TOOLS.find((tool) => tool.name === name)
  if (!definition) throw new Error('Unknown browser tool')
  const args = object(input)
  const allowed = Object.keys(definition.inputSchema.properties ?? {})
  for (const key of Object.keys(args)) if (!allowed.includes(key)) throw new Error(`Unsupported argument: ${key}`)
  for (const required of definition.inputSchema.required ?? []) if (!(required in args)) throw new Error(`Missing argument: ${required}`)
  return args
}

function stringArgument(args: Record<string, unknown>, name: string): string {
  if (typeof args[name] !== 'string') throw new Error(`${name} must be a string`)
  return args[name]
}

function optionalNumber(args: Record<string, unknown>, name: string): number | undefined {
  const value = args[name]
  if (value === undefined) return undefined
  if (typeof value !== 'number') throw new Error(`${name} must be a number`)
  return value
}

function numberArgument(args: Record<string, unknown>, name: string): number {
  const value = optionalNumber(args, name)
  if (value === undefined) throw new Error(`${name} must be a number`)
  return value
}

export async function callBrowserTool(manager: BrowserSessionManager, owner: Pick<BrowserToolOwner, 'taskId' | 'title'>, name: string, input: unknown): Promise<unknown> {
  const args = exactArguments(name, input)
  switch (name) {
    case 'browser_open': return manager.open(owner.taskId, owner.title, stringArgument(args, 'url'))
    case 'browser_snapshot': return manager.snapshot(owner.taskId)
    case 'browser_screenshot': return manager.screenshot(owner.taskId)
    case 'browser_click': {
      const selectorValue = args.selector
      if (selectorValue !== undefined && typeof selectorValue !== 'string') throw new Error('selector must be a string')
      return manager.click(owner.taskId, { selector: selectorValue, x: optionalNumber(args, 'x'), y: optionalNumber(args, 'y') })
    }
    case 'browser_type': return manager.type(owner.taskId, stringArgument(args, 'selector'), stringArgument(args, 'text'))
    case 'browser_press': return manager.press(owner.taskId, stringArgument(args, 'key'))
    case 'browser_scroll': return manager.scroll(owner.taskId, numberArgument(args, 'deltaX'), numberArgument(args, 'deltaY'))
    case 'browser_evaluate': return manager.evaluate(owner.taskId, stringArgument(args, 'expression'))
    case 'browser_viewport': {
      const viewport = stringArgument(args, 'viewport')
      if (viewport !== 'desktop' && viewport !== 'mobile') throw new Error('viewport must be desktop or mobile')
      return manager.viewport(owner.taskId, viewport)
    }
    case 'browser_close': manager.close(owner.taskId); return { closed: true }
    default: throw new Error('Unknown browser tool')
  }
}

export class BrowserToolServer {
  private readonly owners = new Map<string, BrowserToolOwner>()
  private server?: ServerType
  private starting?: Promise<string>
  private closed = false
  private remoteHost?: string

  constructor(private readonly manager: BrowserSessionManager) {}

  setRemoteHost(host: string | undefined): void {
    this.remoteHost = host
    this.manager.setRemoteHost(host)
  }

  private start(): Promise<string> {
    if (this.closed) return Promise.reject(new Error('Browser tools are closed'))
    if (this.starting) return this.starting
    this.starting = this.listen().catch((error) => {
      this.starting = undefined
      throw error
    })
    return this.starting
  }

  private async listen(): Promise<string> {
    const [{ Server }, { WebStandardStreamableHTTPServerTransport }, { CallToolRequestSchema, ListToolsRequestSchema }] = await Promise.all([
      import('@modelcontextprotocol/sdk/server/index.js'),
      import('@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'),
      import('@modelcontextprotocol/sdk/types.js')
    ])
    if (this.closed) throw new Error('Browser tools are closed')
    const app = new Hono<{ Bindings: HttpBindings }>()
    app.use('*', async (context, next) => {
      const owner = this.owners.get(context.req.header('authorization') ?? '')
      if (!owner?.active || context.req.header('origin') || context.env.incoming.url !== '/mcp') return context.body(null, 403)
      if (context.req.method !== 'POST') {
        context.header('Allow', 'POST')
        return context.body(null, 405)
      }
      await next()
    })
    app.post('/mcp', async (context) => {
      const authorization = context.req.header('authorization') ?? ''
      const owner = this.owners.get(authorization)
      if (!owner?.active) return context.body(null, 403)
      const turn = owner.turn
      const protocol = new Server({ name: 'anvil_browser', version: '1.0.0' }, { capabilities: { tools: {} } })
      protocol.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: BROWSER_TOOLS }))
      protocol.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
        try {
          if (this.closed || !owner.active || owner.turn !== turn || this.owners.get(authorization) !== owner) throw new Error('Agent turn has ended')
          let args = params.arguments ?? {}
          if (params.name === 'browser_open' && this.remoteHost && typeof args.url === 'string') {
            const url = new URL(args.url)
            if (['localhost', '127.0.0.1', '[::1]', '::1'].includes(url.hostname)) {
              url.hostname = this.remoteHost.includes(':') ? `[${this.remoteHost}]` : this.remoteHost
              args = { ...args, url: url.toString() }
            }
          }
          const result = await callBrowserTool(this.manager, owner, params.name, args)
          if (params.name === 'browser_screenshot') {
            const screenshot = result as Awaited<ReturnType<BrowserSessionManager['screenshot']>>
            return { content: [{ type: 'image', data: screenshot.data, mimeType: screenshot.mimeType }, { type: 'text', text: JSON.stringify({ url: screenshot.url }) }] }
          }
          return { content: [{ type: 'text', text: JSON.stringify(result) }] }
        } catch (error) {
          return { isError: true, content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }] }
        }
      })
      const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
      context.env.outgoing.once('close', () => { void protocol.close() })
      await protocol.connect(transport)
      return transport.handleRequest(context.req.raw)
    })
    app.onError((_, context) => context.body(null, 500))
    const server = createAdaptorServer({ fetch: app.fetch, overrideGlobalObjects: false })
    this.server = server
    return new Promise<string>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '0.0.0.0', () => {
        server.removeListener('error', reject)
        const address = server.address()
        if (!address || typeof address === 'string') {
          reject(new Error('Browser tools did not bind'))
          return
        }
        resolve(`http://127.0.0.1:${address.port}/mcp`)
      })
    })
  }

  async open(taskId: string, title: string): Promise<BrowserToolConnectionData> {
    const url = await this.start()
    if (this.closed) throw new Error('Browser tools are closed')
    let entry = [...this.owners.entries()].find(([, owner]) => owner.taskId === taskId)
    if (!entry) {
      entry = [`Bearer ${randomBytes(32).toString('hex')}`, { taskId, title, active: false, turn: 0 }]
      this.owners.set(...entry)
    }
    const [authorization, owner] = entry
    if (owner.active) throw new Error('Browser tools are already active for this task')
    owner.title = title
    owner.active = true
    owner.turn++
    return { url, headers: { Authorization: authorization } }
  }

  release(taskId: string): void {
    const owner = [...this.owners.values()].find((candidate) => candidate.taskId === taskId)
    if (owner) owner.active = false
    this.manager.close(taskId)
  }

  async close(): Promise<void> {
    this.closed = true
    this.owners.clear()
    this.manager.closeAll()
    await this.starting?.catch(() => {})
    const server = this.server
    if (server?.listening) {
      await new Promise<void>((resolve) => {
        server.close(() => resolve())
        if ('closeAllConnections' in server) server.closeAllConnections()
      })
    }
  }
}
