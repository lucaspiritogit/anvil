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
