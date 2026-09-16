import { afterEach, expect, test, vi } from 'vitest'
import { startCanvasFrames } from '../src/components/dither-kit/canvas-frames'

afterEach(() => vi.unstubAllGlobals())

test('canvas frames run on demand and pause while hidden or offscreen', () => {
  let visibilityState: DocumentVisibilityState = 'visible'
  const documentTarget = new EventTarget()
  Object.defineProperty(documentTarget, 'visibilityState', { get: () => visibilityState })
  vi.stubGlobal('document', documentTarget)

  let intersection = (_visible: boolean): void => {}
  const disconnect = vi.fn()
  vi.stubGlobal('IntersectionObserver', class {
    constructor(callback: IntersectionObserverCallback) {
      intersection = (visible) => callback([{ isIntersecting: visible } as IntersectionObserverEntry], this as unknown as IntersectionObserver)
    }
    observe(): void {}
    disconnect(): void { disconnect() }
  })

  let nextFrame = 0
  const frames = new Map<number, FrameRequestCallback>()
  const request = vi.fn((callback: FrameRequestCallback) => {
    const id = ++nextFrame
    frames.set(id, callback)
    return id
  })
  const cancel = vi.fn((id: number) => { frames.delete(id) })
  vi.stubGlobal('requestAnimationFrame', request)
  vi.stubGlobal('cancelAnimationFrame', cancel)

  const runFrame = (): void => {
    const entry = frames.entries().next().value as [number, FrameRequestCallback] | undefined
    expect(entry).toBeDefined()
    frames.delete(entry![0])
    entry![1](performance.now())
  }
  const draw = vi.fn(() => false)
  const scheduler = startCanvasFrames({} as HTMLCanvasElement, draw)

  expect(frames.size).toBe(1)
  intersection(false)
  expect(frames.size).toBe(0)
  intersection(true)
  runFrame()
  expect(draw).toHaveBeenCalledTimes(1)
  expect(frames.size).toBe(0)

  draw.mockReturnValueOnce(true)
  scheduler.invalidate()
  runFrame()
  expect(frames.size).toBe(1)
  runFrame()
  expect(frames.size).toBe(0)

  scheduler.invalidate()
  visibilityState = 'hidden'
  documentTarget.dispatchEvent(new Event('visibilitychange'))
  expect(frames.size).toBe(0)
  visibilityState = 'visible'
  documentTarget.dispatchEvent(new Event('visibilitychange'))
  expect(frames.size).toBe(1)

  scheduler.stop()
  expect(frames.size).toBe(0)
  expect(cancel).toHaveBeenCalled()
  expect(disconnect).toHaveBeenCalledOnce()
})
