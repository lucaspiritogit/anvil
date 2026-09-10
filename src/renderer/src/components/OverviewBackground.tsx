import type { JSX } from 'react'
import { memo, useEffect, useRef, useState } from 'react'
import { useStore } from '../state/store'
import { renderWallpaper } from './wallpaper-effects'
import { loadWallpaper } from '../state/wallpaper-cache'
import { DEFAULT_OVERVIEW_COLOR } from '@shared/appearance'

function WallpaperLayer({ image, color }: { image: HTMLImageElement; color: string }): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    const host = canvas?.parentElement
    if (!canvas || !host) return
    let frame = 0
    const draw = (): void => {
      frame = 0
      renderWallpaper(canvas, image, host.clientWidth, host.clientHeight, color)
    }
    const schedule = (): void => {
      if (!frame) frame = requestAnimationFrame(draw)
    }
    schedule()
    const observer = new ResizeObserver(schedule)
    observer.observe(host)
    return () => {
      observer.disconnect()
      if (frame) cancelAnimationFrame(frame)
    }
  }, [image, color])

  return (
    <canvas
      ref={canvasRef}
      aria-hidden
      data-testid="overview-wallpaper"
      data-src={image.src}
      className="pointer-events-none absolute inset-0 h-full w-full"
    />
  )
}

function OverviewBackgroundImpl(): JSX.Element | null {
  // The full-shell layer only exists for the project overview. Keeping this a
  // single boolean means unrelated store updates (task streams, sidebar
  // collapse, resizes) do not reconcile the wallpaper.
  const visible = useStore((s) => {
    if (!s.projects.some((project) => project.id === s.activeProjectId)) return false
    if (s.settingsOpen) return false
    const view = s.view
    if (view.kind !== 'task') return true
    return !s.tasks.some((task) => task.id === view.taskId)
  })
  const color = useStore((s) => s.settings?.overviewBackgroundColor ?? DEFAULT_OVERVIEW_COLOR)
  const workspaceId = useStore((s) => s.activeWorkspaceId) ?? undefined
  const wallpaperMode = useStore((s) => s.settings?.overviewBackgroundMode)
  const wallpaperId = useStore((s) => s.settings?.overviewWallpaperId)
  const [image, setImage] = useState<HTMLImageElement | null>(null)

  useEffect(() => {
    let cancelled = false
    if (!visible || wallpaperMode !== 'image' || !wallpaperId) {
      setImage(null)
      return
    }
    setImage(null)
    void loadWallpaper(wallpaperId, { workspaceId }).then((entry) => {
      if (cancelled) return
      setImage(entry ? entry.image : null)
    }).catch(() => { if (!cancelled) setImage(null) })
    return () => { cancelled = true }
  }, [visible, wallpaperMode, wallpaperId, workspaceId])

  if (!visible) return null

  return (
    <div
      aria-hidden
      data-testid="overview-background"
      className="pointer-events-none absolute inset-0 -z-10"
      style={{ backgroundColor: color }}
    >
      {image && <WallpaperLayer image={image} color={color} />}
    </div>
  )
}

export const OverviewBackground = memo(OverviewBackgroundImpl)
