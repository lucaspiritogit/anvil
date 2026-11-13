export type BrowserViewport = 'desktop' | 'mobile'

export const BROWSER_VIEWPORTS: Record<BrowserViewport, { width: number; height: number }> = {
  desktop: { width: 1280, height: 800 },
  mobile: { width: 390, height: 844 }
}

export const BROWSER_ZOOM_LEVELS = [0.5, 0.67, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2]

export function clampBrowserZoom(value: number): number {
  if (!Number.isFinite(value)) return 1
  return Math.min(BROWSER_ZOOM_LEVELS[BROWSER_ZOOM_LEVELS.length - 1], Math.max(BROWSER_ZOOM_LEVELS[0], value))
}

export interface BrowserObservationState {
  taskId: string
  open: boolean
  viewport: BrowserViewport
  url?: string
  title?: string
  loading?: boolean
  canGoBack?: boolean
  canGoForward?: boolean
}

export interface BrowserObservationLayout {
  taskId: string
  visible: boolean
  bounds: {
    x: number
    y: number
    width: number
    height: number
  }
  zoom?: number
  fit?: boolean
}

export interface BrowserViewportRequest {
  taskId: string
  viewport: BrowserViewport
}

export type BrowserNavigationAction = 'open' | 'back' | 'forward' | 'reload' | 'stop' | 'close'

export const BROWSER_NAVIGATION_ACTIONS: readonly BrowserNavigationAction[] = ['open', 'back', 'forward', 'reload', 'stop', 'close']

export interface BrowserNavigationRequest {
  taskId: string
  action: BrowserNavigationAction
  url?: string
}

const SEARCH_URL = 'https://duckduckgo.com/?q='

export function browserAddress(value: string): string {
  const trimmed = value.trim()
  if (/^\d{1,5}(?:[/?#].*)?$/.test(trimmed)) return `http://localhost:${trimmed}`
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) return trimmed
  const match = /^(\[[\da-f:]+\]|[^\s/?#:]+)(:\d{1,5})?(?:[/?#]\S*)?$/i.exec(trimmed)
  const host = match?.[1].toLowerCase()
  if (!host || !match?.[2] && host !== 'localhost' && !host.includes('.')) return `${SEARCH_URL}${encodeURIComponent(trimmed)}`
  const local = !host.includes('.') || host.startsWith('[') || /^(?:\d{1,3}\.){3}\d{1,3}$/.test(host) || /\.(?:local|localhost)$/.test(host)
  return `${local ? 'http' : 'https'}://${trimmed}`
}
