type FrameScheduler = {
  invalidate: () => void
  stop: () => void
}

export function startCanvasFrames(canvas: HTMLCanvasElement, draw: (now: number) => boolean): FrameScheduler {
  let frame: number | undefined
  let stopped = false
  let pageVisible = document.visibilityState !== "hidden"
  let elementVisible = true

  const cancel = (): void => {
    if (frame === undefined) return
    cancelAnimationFrame(frame)
    frame = undefined
  }
  const invalidate = (): void => {
    if (stopped || frame !== undefined || !pageVisible || !elementVisible) return
    frame = requestAnimationFrame((now) => {
      frame = undefined
      if (draw(now)) invalidate()
    })
  }
  const onVisibilityChange = (): void => {
    pageVisible = document.visibilityState !== "hidden"
    if (pageVisible) invalidate()
    else cancel()
  }
  document.addEventListener("visibilitychange", onVisibilityChange)

  const observer = typeof IntersectionObserver === "undefined" ? undefined : new IntersectionObserver(([entry]) => {
    elementVisible = entry?.isIntersecting ?? false
    if (elementVisible) invalidate()
    else cancel()
  })
  observer?.observe(canvas)
  invalidate()

  return {
    invalidate,
    stop: () => {
      stopped = true
      cancel()
      observer?.disconnect()
      document.removeEventListener("visibilitychange", onVisibilityChange)
    }
  }
}
