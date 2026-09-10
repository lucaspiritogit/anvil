import type { JSX } from 'react'
import { useEffect, useRef, useState } from 'react'
import { useStore } from '../state/store'
import { TaskComposer } from './TaskComposer'
import { renderWallpaper } from './wallpaper-effects'
import { cn } from '../ui'
import { loadWallpaper } from '../state/wallpaper-cache'
import { DEFAULT_OVERVIEW_COLOR } from '@shared/appearance'
import type { Project } from '@shared/types'

interface Props {
  project: Project
}

const SPREAD = 'w-full max-w-[1040px] mx-auto'

function GitAlert({ project }: { project: Project }): JSX.Element | null {
  const status = useStore((s) => s.gitStatusByProject[project.id])
  const pending = useStore((s) => s.gitInitPending === project.id)
  const error = useStore((s) => s.gitInitError)
  const loadGitStatus = useStore((s) => s.loadGitStatus)
  const initGitRepo = useStore((s) => s.initGitRepo)

  useEffect(() => {
    void loadGitStatus(project.id)
  }, [loadGitStatus, project.id])

  if (!status || status.isRepository) return null

  const canInit = status.pathExists && status.gitAvailable
  const detail = !status.pathExists
    ? 'The project folder no longer exists at this path.'
    : status.gitAvailable
      ? 'Agents will run directly in the project folder. Task branches and reviewable diffs are skipped.'
      : 'Git could not be run on this machine, so task branches and reviewable diffs are skipped.'

  return (
    <div
      className={cn(
        'flex gap-4 items-center justify-between px-[18px] py-3.5 mb-6',
        'text-warn bg-warn/8 border border-warn/35'
      )}
      role="status"
    >
      <div className="flex flex-col gap-[3px]">
        <strong className="text-[13px] font-semibold">This project is not using Git</strong>
        <span className="text-xs text-dim">{detail}</span>
        {error && <span className="text-xs text-danger">{error}</span>}
      </div>
      {canInit && (
        <button
          className="flex-none px-3.5 py-[7px] font-medium text-warn whitespace-nowrap border border-warn/45 enabled:hover:bg-warn/12 disabled:opacity-50 disabled:cursor-not-allowed"
          disabled={pending}
          onClick={() => void initGitRepo(project.id)}
        >
          {pending ? 'Initializing…' : 'Initialize Git repository'}
        </button>
      )}
    </div>
  )
}

function WallpaperLayer({ image, color }: { image: HTMLImageElement; color: string }): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    const host = canvas?.parentElement
    if (!canvas || !host) return
    let frame = 0
    let settle = 0
    const draw = (): void => {
      frame = 0
      // The sidebar collapse resizes the host every animation frame; while it
      // runs, stretch the existing canvas instead of re-rendering the wallpaper
      // and redraw once the size settles so the slide never races the paint.
      const scale = Math.min(window.devicePixelRatio || 1, 2)
      const width = Math.round(host.clientWidth * scale)
      const height = Math.round(host.clientHeight * scale)
      if (canvas.width === width && canvas.height === height) return
      renderWallpaper(canvas, image, host.clientWidth, host.clientHeight, color)
    }
    const schedule = (): void => {
      if (!frame) frame = requestAnimationFrame(draw)
    }
    const scheduleSettled = (): void => {
      if (settle) clearTimeout(settle)
      settle = window.setTimeout(() => {
        settle = 0
        schedule()
      }, 200)
    }
    schedule()
    const observer = new ResizeObserver(scheduleSettled)
    observer.observe(host)
    return () => {
      observer.disconnect()
      if (frame) cancelAnimationFrame(frame)
      if (settle) clearTimeout(settle)
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

export function ProjectOverview({ project }: Props): JSX.Element {
  const settings = useStore((s) => s.settings)
  const color = settings?.overviewBackgroundColor ?? DEFAULT_OVERVIEW_COLOR
  const workspaceId = useStore((state) => state.activeWorkspaceId) ?? undefined
  const wallpaperMode = settings?.overviewBackgroundMode
  const wallpaperId = settings?.overviewWallpaperId
  const [image, setImage] = useState<HTMLImageElement | null>(null)

  useEffect(() => {
    let cancelled = false
    setImage(null)
    if (wallpaperMode === 'image' && wallpaperId) {
      void loadWallpaper(wallpaperId, { workspaceId }).then((entry) => {
        if (cancelled) return
        setImage(entry ? entry.image : null)
      }).catch(() => { if (!cancelled) setImage(null) })
    } else {
      setImage(null)
    }
    return () => { cancelled = true }
  }, [wallpaperMode, wallpaperId, workspaceId])

  return (
    <div data-testid="project-overview" className="relative h-full min-h-0" style={{ backgroundColor: color }}>
      {image && <WallpaperLayer image={image} color={color} />}
      <div className="relative flex h-full min-h-0 flex-col overflow-y-auto px-8 py-8 max-[980px]:px-[22px]">
        <div className={cn(SPREAD, 'my-auto')}>
          <GitAlert project={project} />
          <TaskComposer key={project.id} />
        </div>
      </div>
    </div>
  )
}
