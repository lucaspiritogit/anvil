import type { BrowserObservationLayout, BrowserViewportRequest } from './browser-observation'
import type { ServerTarget } from './server-address'

export interface DesktopServerConnectionState {
  target: ServerTarget
  url: string
}

export interface DesktopRequests {
  'desktop:pick-wallpaper': undefined
  'desktop:open-path': string
  'desktop:open-pr-url': string
  'desktop:open-login-url': string
  'desktop:browser-state': string
  'desktop:browser-layout': BrowserObservationLayout
  'desktop:browser-viewport': BrowserViewportRequest
  'desktop:server-target': undefined
  'desktop:set-server-target': ServerTarget
}

function text(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 4_096 && !/[\x00-\x1f]/.test(value)
}

function browserLayout(value: unknown): value is BrowserObservationLayout {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const input = value as Partial<BrowserObservationLayout>
  if (!text(input.taskId) || typeof input.visible !== 'boolean' || !input.bounds || typeof input.bounds !== 'object') return false
  if (Object.keys(input).some((key) => !['taskId', 'visible', 'bounds', 'zoom', 'fit'].includes(key))) return false
  if (input.zoom !== undefined && (typeof input.zoom !== 'number' || !Number.isFinite(input.zoom) || input.zoom < 0.25 || input.zoom > 4)) return false
  if (input.fit !== undefined && typeof input.fit !== 'boolean') return false
  if (Object.keys(input.bounds).some((key) => !['x', 'y', 'width', 'height'].includes(key))) return false
  const validCoordinates = ['x', 'y', 'width', 'height'].every((key) => {
    const coordinate = input.bounds?.[key as keyof BrowserObservationLayout['bounds']]
    return Number.isInteger(coordinate) && coordinate !== undefined && coordinate >= 0 && coordinate <= 10_000
  })
  return validCoordinates && (!input.visible || input.bounds.width >= 1 && input.bounds.height >= 1)
}

function browserViewport(value: unknown): value is BrowserViewportRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const input = value as Partial<BrowserViewportRequest>
  return Object.keys(input).every((key) => ['taskId', 'viewport'].includes(key))
    && Object.keys(input).length === 2
    && text(input.taskId)
    && (input.viewport === 'desktop' || input.viewport === 'mobile')
}

function serverTarget(value: unknown): value is ServerTarget {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const input = value as Partial<ServerTarget>
  const keys = Object.keys(input)
  if (input.mode === 'local') return keys.length === 1 && keys[0] === 'mode'
  return input.mode === 'remote' && keys.length === 2 && keys.includes('mode') && keys.includes('url') && text(input.url)
}

export function isDesktopRequest<C extends keyof DesktopRequests>(channel: C, value: unknown): value is DesktopRequests[C] {
  switch (channel) {
    case 'desktop:pick-wallpaper':
    case 'desktop:server-target': return value === undefined
    case 'desktop:browser-layout': return browserLayout(value)
    case 'desktop:browser-viewport': return browserViewport(value)
    case 'desktop:set-server-target': return serverTarget(value)
    default: return text(value)
  }
}
