import type { MouseInputEvent, Rectangle, WebContents, WebPreferences } from 'electron'
import { randomUUID } from 'node:crypto'
import { BROWSER_VIEWPORTS, clampBrowserZoom, type BrowserObservationLayout, type BrowserObservationState, type BrowserViewport } from '../../shared/browser-observation'

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]'])
const MAX_EXPRESSION_LENGTH = 20_000
const MAX_RESULT_LENGTH = 100_000
const MAX_TEXT_LENGTH = 20_000
export interface BrowserSessionView {
  webContents: WebContents
  setBounds(bounds: Rectangle): void
  setVisible(visible: boolean): void
}

export interface BrowserSessionViewHost {
  create(webPreferences: WebPreferences): BrowserSessionView
  remove(view: BrowserSessionView): void
}

interface BrowserSession {
  view: BrowserSessionView
  viewport: BrowserViewport
  layout?: BrowserObservationLayout
}

export interface BrowserSnapshot {
  url: string
  title: string
  viewport: { width: number; height: number }
  text: string
  elements: Array<{
    selector: string
    tag: string
    role: string
    name: string
    value: string
    disabled: boolean
    checked: boolean | null
    bounds: { x: number; y: number; width: number; height: number }
  }>
}

export function browserUrl(value: string, remoteHost?: string): string {
  if (value.length > 4_096) throw new Error('Browser URL is too long')
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error('Browser URL is invalid')
  }
  if (!['http:', 'https:'].includes(url.protocol) || (!LOOPBACK_HOSTS.has(url.hostname) && url.hostname !== remoteHost) || url.username || url.password) {
    throw new Error('The agent browser only opens task-server HTTP or HTTPS URLs')
  }
  return url.href
}

function selectorScript(selector: string): string {
  if (!selector || selector.length > 2_000) throw new Error('Selector must contain between 1 and 2000 characters')
  return JSON.stringify(selector)
}

function point(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0 || value > 10_000) throw new Error(`${name} must be between 0 and 10000`)
  return value
}

function boundedDelta(value: number, name: string): number {
  if (!Number.isFinite(value) || value < -10_000 || value > 10_000) throw new Error(`${name} must be between -10000 and 10000`)
  return value
}

function textResult(value: unknown): unknown {
  const serialized = JSON.stringify(value ?? null)
  if (serialized.length > MAX_RESULT_LENGTH) throw new Error('Browser result is too large')
  return JSON.parse(serialized)
}

export class BrowserSessionManager {
  private readonly sessions = new Map<string, BrowserSession>()
  private remoteHost?: string

  constructor(
    private readonly host: BrowserSessionViewHost,
    private readonly changed: (state: BrowserObservationState) => void = () => {}
  ) {}

  setRemoteHost(host: string | undefined): void {
    this.remoteHost = host
  }

  private session(taskId: string): BrowserSession {
    const session = this.sessions.get(taskId)
    if (!session || session.view.webContents.isDestroyed()) throw new Error('Open a page in the agent browser first')
    return session
  }

  private create(taskId: string): BrowserSession {
    const view = this.host.create({
      partition: `anvil-browser-${randomUUID()}`,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      focusOnNavigation: false,
      webSecurity: true
    })
    view.setBounds({ x: 0, y: 0, width: 0, height: 0 })
    view.setVisible(false)
    const contents = view.webContents
    const allowedNavigation = (value: string): boolean => {
      try {
        browserUrl(value, this.remoteHost)
        return true
      } catch {
        return false
      }
    }
    contents.session.setPermissionCheckHandler(() => false)
    contents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
    contents.session.on('will-download', (event) => event.preventDefault())
    contents.setWindowOpenHandler(() => ({ action: 'deny' }))
    contents.on('will-navigate', (event, url) => {
      if (!allowedNavigation(url)) event.preventDefault()
    })
    contents.on('will-redirect', (event, url, _inPlace, isMainFrame) => {
      if (isMainFrame && !allowedNavigation(url)) event.preventDefault()
    })
    contents.on('destroyed', () => {
      if (this.sessions.get(taskId)?.view === view) {
        this.sessions.delete(taskId)
        this.host.remove(view)
        this.changed({ taskId, open: false, viewport: session.viewport })
      }
    })
    const session: BrowserSession = { view, viewport: 'desktop' }
    this.sessions.set(taskId, session)
    return session
  }

  async open(taskId: string, _title: string, urlValue: string): Promise<BrowserSnapshot> {
    const url = browserUrl(urlValue, this.remoteHost)
    let session = this.sessions.get(taskId)
    if (!session || session.view.webContents.isDestroyed()) session = this.create(taskId)
    await session.view.webContents.loadURL(url)
    this.changed({ taskId, open: true, viewport: session.viewport })
    return this.snapshot(taskId)
  }

  state(taskId: string): BrowserObservationState {
    const session = this.sessions.get(taskId)
    return { taskId, open: Boolean(session && !session.view.webContents.isDestroyed()), viewport: session?.viewport ?? 'desktop' }
  }

  layout(input: BrowserObservationLayout): void {
    const session = this.sessions.get(input.taskId)
    if (!session || session.view.webContents.isDestroyed()) return
    session.layout = input
    if (!input.visible) {
      session.view.setVisible(false)
      return
    }
    this.place(session)
  }

  viewport(taskId: string, viewport: BrowserViewport): BrowserObservationState {
    const session = this.session(taskId)
    if (!BROWSER_VIEWPORTS[viewport]) throw new Error('Browser viewport must be desktop or mobile')
    session.viewport = viewport
    if (session.layout?.visible) this.place(session)
    const state = { taskId, open: true, viewport }
    this.changed(state)
    return state
  }

  private place(session: BrowserSession): void {
    const layout = session.layout
    if (!layout?.visible) return
    for (const [taskId, candidate] of this.sessions) {
      if (taskId !== layout.taskId && !candidate.view.webContents.isDestroyed()) candidate.view.setVisible(false)
    }
    const zoom = clampBrowserZoom(layout.zoom ?? 1)
    if (layout.fit === false && session.viewport === 'desktop') {
      session.view.webContents.setZoomFactor(zoom)
      session.view.setBounds({
        x: layout.bounds.x,
        y: layout.bounds.y,
        width: layout.bounds.width,
        height: layout.bounds.height
      })
      session.view.setVisible(true)
      return
    }
    const viewport = BROWSER_VIEWPORTS[session.viewport]
    const scale = Math.min(1, layout.bounds.width / viewport.width, layout.bounds.height / viewport.height)
    const width = Math.max(1, Math.floor(viewport.width * scale))
    const height = Math.max(1, Math.floor(viewport.height * scale))
    session.view.webContents.setZoomFactor(scale * zoom)
    session.view.setBounds({
      x: layout.bounds.x + Math.floor((layout.bounds.width - width) / 2),
      y: layout.bounds.y + Math.floor((layout.bounds.height - height) / 2),
      width,
      height
    })
    session.view.setVisible(true)
  }

  async snapshot(taskId: string): Promise<BrowserSnapshot> {
    const { view } = this.session(taskId)
    const snapshot = await view.webContents.executeJavaScript(`(() => {
      const selectorFor = (element) => {
        if (element.id) return '#' + CSS.escape(element.id)
        const testId = element.getAttribute('data-testid')
        if (testId) return '[data-testid=' + JSON.stringify(testId) + ']'
        const parts = []
        let current = element
        while (current && current !== document.body && parts.length < 6) {
          const tag = current.tagName.toLowerCase()
          const parent = current.parentElement
          if (!parent) break
          const siblings = Array.from(parent.children).filter((entry) => entry.tagName === current.tagName)
          const suffix = siblings.length > 1 ? ':nth-of-type(' + (siblings.indexOf(current) + 1) + ')' : ''
          parts.unshift(tag + suffix)
          current = parent
        }
        return parts.length ? 'body > ' + parts.join(' > ') : 'body'
      }
      const interactive = Array.from(document.querySelectorAll('a, button, input, select, textarea, [role], [contenteditable="true"]')).slice(0, 300)
      return {
        url: location.href,
        title: document.title,
        viewport: { width: innerWidth, height: innerHeight },
        text: (document.body?.innerText || '').slice(0, ${MAX_TEXT_LENGTH}),
        elements: interactive.map((element) => {
          const bounds = element.getBoundingClientRect()
          const input = element instanceof HTMLInputElement ? element : null
          return {
            selector: selectorFor(element),
            tag: element.tagName.toLowerCase(),
            role: element.getAttribute('role') || '',
            name: element.getAttribute('aria-label') || element.getAttribute('placeholder') || element.getAttribute('name') || (element.textContent || '').trim().slice(0, 200),
            value: 'value' in element ? String(element.value).slice(0, 500) : '',
            disabled: 'disabled' in element ? Boolean(element.disabled) : element.getAttribute('aria-disabled') === 'true',
            checked: input && ['checkbox', 'radio'].includes(input.type) ? input.checked : null,
            bounds: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height }
          }
        })
      }
    })()`)
    return textResult(snapshot) as BrowserSnapshot
  }

  async screenshot(taskId: string): Promise<{ data: string; mimeType: 'image/png'; url: string }> {
    const { view } = this.session(taskId)
    const image = await view.webContents.capturePage()
    const png = image.toPNG()
    if (png.byteLength > 8 * 1024 * 1024) throw new Error('Browser screenshot exceeds 8 MiB')
    return { data: png.toString('base64'), mimeType: 'image/png', url: view.webContents.getURL() }
  }

  async click(taskId: string, input: { selector?: string; x?: number; y?: number }): Promise<BrowserSnapshot> {
    const { view } = this.session(taskId)
    let x = input.x
    let y = input.y
    if (input.selector !== undefined) {
      const bounds = await view.webContents.executeJavaScript(`(() => {
        const element = document.querySelector(${selectorScript(input.selector)})
        if (!element) throw new Error('Browser selector did not match an element')
        element.scrollIntoView({ block: 'center', inline: 'center' })
        const bounds = element.getBoundingClientRect()
        return { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 }
      })()`) as { x: number; y: number }
      x = bounds.x
      y = bounds.y
    }
    if (x === undefined || y === undefined) throw new Error('Provide a selector or both click coordinates')
    const clickX = point(x, 'x')
    const clickY = point(y, 'y')
    const events: MouseInputEvent[] = [
      { type: 'mouseMove', x: clickX, y: clickY },
      { type: 'mouseDown', x: clickX, y: clickY, button: 'left', clickCount: 1 },
      { type: 'mouseUp', x: clickX, y: clickY, button: 'left', clickCount: 1 }
    ]
    for (const event of events) view.webContents.sendInputEvent(event)
    await new Promise((resolve) => setTimeout(resolve, 50))
    return this.snapshot(taskId)
  }

  async type(taskId: string, selector: string, text: string): Promise<BrowserSnapshot> {
    if (text.length > 10_000) throw new Error('Browser text input exceeds 10000 characters')
    const { view } = this.session(taskId)
    await view.webContents.executeJavaScript(`(() => {
      const element = document.querySelector(${selectorScript(selector)})
      if (!element) throw new Error('Browser selector did not match an element')
      element.scrollIntoView({ block: 'center', inline: 'center' })
      element.focus()
      const text = ${JSON.stringify(text)}
      if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
        const prototype = element instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype
        const setter = Object.getOwnPropertyDescriptor(prototype, 'value').set
        setter.call(element, text)
      } else if (element.isContentEditable) {
        element.textContent = text
      } else {
        throw new Error('Browser selector is not editable')
      }
      element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }))
      element.dispatchEvent(new Event('change', { bubbles: true }))
    })()`)
    return this.snapshot(taskId)
  }

  async press(taskId: string, key: string): Promise<BrowserSnapshot> {
    if (!/^(?:[A-Za-z0-9]|Arrow(?:Up|Down|Left|Right)|Enter|Escape|Tab|Backspace|Delete|Home|End|Page(?:Up|Down)|Space)$/.test(key) || key.length > 20) {
      throw new Error('Unsupported browser key')
    }
    const { view } = this.session(taskId)
    view.webContents.sendInputEvent({ type: 'keyDown', keyCode: key })
    view.webContents.sendInputEvent({ type: 'keyUp', keyCode: key })
    await new Promise((resolve) => setTimeout(resolve, 25))
    return this.snapshot(taskId)
  }

  async scroll(taskId: string, deltaX: number, deltaY: number): Promise<BrowserSnapshot> {
    const { view } = this.session(taskId)
    const x = boundedDelta(deltaX, 'deltaX')
    const y = boundedDelta(deltaY, 'deltaY')
    await view.webContents.executeJavaScript(`window.scrollBy(${x}, ${y})`)
    return this.snapshot(taskId)
  }

  async evaluate(taskId: string, expression: string): Promise<unknown> {
    if (!expression.trim() || expression.length > MAX_EXPRESSION_LENGTH) throw new Error('Browser expression must contain between 1 and 20000 characters')
    const { view } = this.session(taskId)
    const result = await view.webContents.executeJavaScript(`(async () => {
      const value = await (0, eval)(${JSON.stringify(expression)})
      return JSON.parse(JSON.stringify(value ?? null))
    })()`)
    return textResult(result)
  }

  close(taskId: string): void {
    const session = this.sessions.get(taskId)
    this.sessions.delete(taskId)
    if (!session) return
    this.host.remove(session.view)
    if (!session.view.webContents.isDestroyed()) session.view.webContents.close()
    this.changed({ taskId, open: false, viewport: session.viewport })
  }

  closeAll(): void {
    for (const taskId of [...this.sessions.keys()]) this.close(taskId)
  }
}
