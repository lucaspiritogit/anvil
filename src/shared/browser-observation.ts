export type BrowserViewport = 'desktop' | 'mobile'

export const BROWSER_VIEWPORTS: Record<BrowserViewport, { width: number; height: number }> = {
  desktop: { width: 1280, height: 800 },
  mobile: { width: 390, height: 844 }
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
}

export interface BrowserViewportRequest {
  taskId: string
  viewport: BrowserViewport
}
