import type { JSX, PointerEvent as ReactPointerEvent } from 'react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { BROWSER_VIEWPORTS, BROWSER_ZOOM_LEVELS, browserAddress, type BrowserNavigationAction, type BrowserObservationState } from '@anvil/protocol/browser-observation'
import { btn, cn } from '../ui'
import { Icon } from '../icons'

const BROWSER_HEADER_HEIGHT = 64
const BROWSER_DEFAULT_WIDTH_RATIO = 0.48
const BROWSER_MIN_WIDTH_RATIO = 0.2
const BROWSER_RATIO_STORAGE_KEY = 'anvil.browser-pane-ratio'

function clampBrowserRatio(value: number): number {
  return Math.min(1, Math.max(BROWSER_MIN_WIDTH_RATIO, value))
}

function loadBrowserRatio(): number {
  try {
    const stored = Number(window.localStorage.getItem(BROWSER_RATIO_STORAGE_KEY))
    if (Number.isFinite(stored) && stored > 0) return clampBrowserRatio(stored)
  } catch {}
  return BROWSER_DEFAULT_WIDTH_RATIO
}

function storeBrowserRatio(value: number): void {
  try { window.localStorage.setItem(BROWSER_RATIO_STORAGE_KEY, String(value)) } catch {}
}


export function useTaskBrowser(taskId: string): BrowserObservationState {
  const [state, setState] = useState<BrowserObservationState>({ taskId, open: false, viewport: 'desktop' })
  useEffect(() => {
    let active = true
    let changed = false
    setState({ taskId, open: false, viewport: 'desktop' })
    const stop = window.anvil.browser.onChanged((next) => {
      if (next.taskId !== taskId) return
      changed = true
      if (active) setState(next)
    })
    void window.anvil.browser.state(taskId).then((next) => {
      if (active && !changed) setState(next)
    }).catch(() => {})
    return () => {
      active = false
      stop()
    }
  }, [taskId])
  return state
}

export function BrowserPane({ state, visible, onClose, hint }: { state: BrowserObservationState; visible: boolean; onClose: () => void; hint?: string }): JSX.Element {
  const { taskId, open, viewport } = state
  const navigateAvailable = Boolean(window.anvil.browser.navigate)
  const [address, setAddress] = useState(state.url ?? '')
  const [editing, setEditing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const addressRef = useRef<HTMLInputElement>(null)
  const [ratio, setRatio] = useState(loadBrowserRatio)
  const [expanded, setExpanded] = useState(false)
  const [fit, setFit] = useState(false)
  const [zoom, setZoom] = useState(1)
  const [dragging, setDragging] = useState(false)
  const [paneSize, setPaneSize] = useState<{ width: number; height: number } | null>(null)
  const [frameSize, setFrameSize] = useState<{ width: number; height: number } | null>(null)
  const paneRef = useRef<HTMLElement>(null)
  const frameRef = useRef<HTMLDivElement>(null)

  const fitted = viewport === 'mobile' || fit

  useEffect(() => {
    if (!editing) setAddress(state.url ?? '')
  }, [state.url, editing])

  useEffect(() => {
    if (!open && navigateAvailable) addressRef.current?.focus()
  }, [open, navigateAvailable])

  const navigate = (action: BrowserNavigationAction, url?: string): void => {
    const run = window.anvil.browser.navigate
    if (!run) return
    setError(null)
    void run({ taskId, action, ...(url === undefined ? {} : { url }) }).catch((reason: unknown) => {
      const message = reason instanceof Error ? reason.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '') : String(reason)
      if (!message.includes('ERR_ABORTED')) setError(message)
    })
  }

  const close = (): void => {
    if (open) navigate('close')
    onClose()
  }

  useLayoutEffect(() => {
    const pane = paneRef.current
    const container = pane?.parentElement
    if (!open || !visible || !pane || !container || !fitted) {
      setPaneSize(null)
      return
    }
    const dimensions = BROWSER_VIEWPORTS[viewport]
    const measure = (): void => {
      const maximumWidth = Math.floor(container.clientWidth * (expanded ? 1 : ratio))
      const maximumHeight = container.clientHeight - BROWSER_HEADER_HEIGHT
      if (maximumWidth < 1 || maximumHeight < 1) return
      const scale = Math.min(1, maximumWidth / dimensions.width, maximumHeight / dimensions.height)
      const next = {
        width: Math.max(1, Math.floor(dimensions.width * scale)),
        height: Math.max(1, Math.floor(dimensions.height * scale))
      }
      setPaneSize((current) => current?.width === next.width && current.height === next.height ? current : next)
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(container)
    return () => observer.disconnect()
  }, [open, viewport, visible, fitted, ratio, expanded])

  useLayoutEffect(() => {
    const frame = frameRef.current
    const hidden: Parameters<typeof window.anvil.browser.layout>[0] = { taskId, visible: false, bounds: { x: 0, y: 0, width: 0, height: 0 } }
    const place = (layout: Parameters<typeof window.anvil.browser.layout>[0]): void => {
      void window.anvil.browser.layout(layout).catch(() => {})
    }
    if (!open || !visible || !frame || dragging) {
      place(hidden)
      setFrameSize(null)
      return
    }
    let animationFrame = 0
    const measure = (): void => {
      animationFrame = 0
      const bounds = frame.getBoundingClientRect()
      const width = Math.max(0, Math.round(Math.min(bounds.width, window.innerWidth - bounds.x)))
      const height = Math.max(0, Math.round(Math.min(bounds.height, window.innerHeight - bounds.y)))
      setFrameSize((current) => current?.width === width && current.height === height ? current : { width, height })
      place({
        taskId,
        visible: width >= 1 && height >= 1,
        bounds: {
          x: Math.max(0, Math.round(bounds.x)),
          y: Math.max(0, Math.round(bounds.y)),
          width,
          height
        },
        zoom,
        fit: fitted
      })
    }
    const schedule = (): void => {
      if (!animationFrame) animationFrame = window.requestAnimationFrame(measure)
    }
    measure()
    const observer = new ResizeObserver(schedule)
    observer.observe(frame)
    window.addEventListener('resize', schedule)
    return () => {
      if (animationFrame) window.cancelAnimationFrame(animationFrame)
      observer.disconnect()
      window.removeEventListener('resize', schedule)
      place(hidden)
    }
  }, [open, taskId, viewport, visible, zoom, fitted, dragging])

  const dimensions = BROWSER_VIEWPORTS[viewport]
  const nextViewport = viewport === 'desktop' ? 'mobile' : 'desktop'
  const fitScale = fitted && paneSize ? paneSize.width / dimensions.width : 1
  const sizeLabel = fitted
    ? `${dimensions.width} × ${dimensions.height}${fitScale < 1 ? ` · ${Math.round(fitScale * 100)}%` : ''}`
    : frameSize ? `${frameSize.width} × ${frameSize.height}` : `${dimensions.width} × ${dimensions.height}`

  const startResize = (event: ReactPointerEvent<HTMLDivElement>): void => {
    event.preventDefault()
    const container = paneRef.current?.parentElement
    if (!container) return
    const rect = container.getBoundingClientRect()
    setDragging(true)
    const move = (e: PointerEvent): void => {
      setRatio(clampBrowserRatio((rect.right - e.clientX) / rect.width))
    }
    const up = (e: PointerEvent): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      const next = clampBrowserRatio((rect.right - e.clientX) / rect.width)
      setRatio(next)
      storeBrowserRatio(next)
      setDragging(false)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  const stepZoom = (direction: 1 | -1): void => {
    setZoom((current) => {
      const index = BROWSER_ZOOM_LEVELS.indexOf(current)
      const next = (index === -1 ? BROWSER_ZOOM_LEVELS.length - 1 : index) + direction
      return BROWSER_ZOOM_LEVELS[Math.min(BROWSER_ZOOM_LEVELS.length - 1, Math.max(0, next))]
    })
  }

  return (
    <section ref={paneRef} aria-label="Browser"
      style={expanded ? undefined : fitted
        ? paneSize ? { width: paneSize.width, height: paneSize.height + BROWSER_HEADER_HEIGHT } : undefined
        : { width: `${ratio * 100}%` }}
      className={cn('flex min-h-0 shrink-0 flex-col overflow-hidden border-line bg-canvas',
        expanded ? 'absolute inset-0 z-20 h-full w-full' : 'relative self-start border-l',
        !expanded && !fitted && 'h-full self-stretch',
        !expanded && fitted && !paneSize && 'h-full w-[48%]')}>
      {!expanded && <div role="separator" aria-orientation="vertical" aria-label="Resize browser pane" title="Resize browser pane"
        className="absolute inset-y-0 -left-1 z-10 w-2 cursor-col-resize hover:bg-accent/30"
        onPointerDown={startResize} />}
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-line px-3 text-[11px] font-medium text-dim">
        <span className="shrink-0">Browser</span>
        {error
          ? <span role="alert" className="min-w-0 truncate text-danger" title={error}>{error}</span>
          : <span className="min-w-0 truncate tabular-nums" title={state.title || undefined}>{open && state.title ? `${state.title} · ${sizeLabel}` : sizeLabel}</span>}
        <div className="ml-auto flex shrink-0 items-center gap-1">
          {open && viewport === 'desktop' && <button
            className={cn(btn.ghost, 'px-1.5 py-0.5 text-[11px]', fitted && 'text-fg')}
            aria-pressed={fitted}
            title="Scale the fixed 1280 × 800 page to fit the pane"
            onClick={() => setFit((value) => !value)}>
            Fit
          </button>}
          {open && <div role="group" aria-label="Browser zoom" className="flex items-center">
            <button className={cn(btn.ghost, 'px-1.5 py-0.5 text-[11px] disabled:opacity-45')} aria-label="Zoom browser out"
              disabled={zoom <= BROWSER_ZOOM_LEVELS[0]} onClick={() => stepZoom(-1)}>−</button>
            <button className={cn(btn.ghost, 'px-1.5 py-0.5 text-[11px] tabular-nums')} aria-label="Reset browser zoom" title="Reset browser zoom"
              onClick={() => setZoom(1)}>{Math.round(zoom * 100)}%</button>
            <button className={cn(btn.ghost, 'px-1.5 py-0.5 text-[11px] disabled:opacity-45')} aria-label="Zoom browser in"
              disabled={zoom >= BROWSER_ZOOM_LEVELS[BROWSER_ZOOM_LEVELS.length - 1]} onClick={() => stepZoom(1)}>+</button>
          </div>}
          <button className={cn(btn.ghost, 'px-1.5 py-0.5 text-[11px]')} aria-expanded={expanded}
            title={expanded ? 'Restore the browser beside the page' : 'Expand the browser over the page'}
            onClick={() => setExpanded((value) => !value)}>
            {expanded ? 'Restore' : 'Expand'}
          </button>
          {open && <button className={cn(btn.ghost, 'px-2 py-0.5 text-[11px]')} aria-label={`Switch browser to ${nextViewport} view`}
            onClick={() => { void window.anvil.browser.viewport({ taskId, viewport: nextViewport }).catch(() => {}) }}>
            {nextViewport === 'mobile' ? 'Mobile' : 'Desktop'}
          </button>}
          <button className={cn(btn.ghost, 'px-1 py-0.5')} aria-label="Close browser" title={open ? 'Close browser' : 'Hide browser'}
            onClick={close}>
            <Icon icon="x" size={12} aria-hidden="true" />
          </button>
        </div>
      </div>
      <form role="search" aria-label="Browser address" className="flex h-8 shrink-0 items-center gap-1 border-b border-line px-2"
        onSubmit={(event) => {
          event.preventDefault()
          const value = address.trim()
          if (!value) return
          setEditing(false)
          addressRef.current?.blur()
          navigate('open', browserAddress(value))
        }}>
        <button type="button" className={cn(btn.ghost, 'px-1 py-0.5 disabled:opacity-45')} aria-label="Back"
          disabled={!navigateAvailable || !state.canGoBack} onClick={() => navigate('back')}>
          <Icon icon="chevron-left" size={13} aria-hidden="true" />
        </button>
        <button type="button" className={cn(btn.ghost, 'px-1 py-0.5 disabled:opacity-45')} aria-label="Forward"
          disabled={!navigateAvailable || !state.canGoForward} onClick={() => navigate('forward')}>
          <Icon icon="chevron-right" size={13} aria-hidden="true" />
        </button>
        <button type="button" className={cn(btn.ghost, 'w-6 px-1 py-0.5 text-[13px] leading-none disabled:opacity-45')}
          aria-label={state.loading ? 'Stop loading' : 'Reload'} disabled={!navigateAvailable || !open}
          onClick={() => navigate(state.loading ? 'stop' : 'reload')}>
          <span aria-hidden="true">{state.loading ? '×' : '↻'}</span>
        </button>
        <input ref={addressRef} type="text" value={address} aria-label="Browser URL" spellCheck={false} autoComplete="off"
          readOnly={!navigateAvailable} placeholder="Search or enter a URL, e.g. localhost:5173"
          onFocus={(event) => { setEditing(true); event.currentTarget.select() }}
          onBlur={() => setEditing(false)}
          onKeyDown={(event) => {
            if (event.key !== 'Escape') return
            setAddress(state.url ?? '')
            event.currentTarget.blur()
          }}
          onChange={(event) => { setAddress(event.target.value); setError(null) }}
          className={cn('h-6 min-w-0 flex-1 border bg-raised px-2 font-mono text-[11px] text-fg outline-none placeholder:text-faint focus:border-accent',
            error ? 'border-danger' : 'border-line')} />
      </form>
      <div ref={frameRef} className="relative min-h-0 flex-1 bg-canvas">
        {!open && <p className="absolute inset-0 grid place-content-center gap-1 px-6 text-center text-xs text-dim">
          <span>Search or enter a URL to start browsing.</span>
          {hint && <span className="text-faint">{hint}</span>}
        </p>}
      </div>
    </section>
  )
}

export function useBrowserPane(key: string): { state: BrowserObservationState; available: boolean; shown: boolean; setShown: (value: boolean | ((current: boolean) => boolean)) => void } {
  const state = useTaskBrowser(key)
  const available = Boolean(window.anvil.browser.navigate) || state.open
  const [shown, setShown] = useState(false)
  const wasOpen = useRef(false)
  useEffect(() => {
    if (state.open !== wasOpen.current) setShown(state.open)
    wasOpen.current = state.open
  }, [state.open])
  return { state, available, shown, setShown }
}

export function BrowserToggle({ shown, open, onToggle, className }: { shown: boolean; open: boolean; onToggle: () => void; className?: string }): JSX.Element {
  return (
    <button type="button" className={cn(btn.ghost, 'flex items-center gap-1.5 px-2 py-1 font-mono text-[11px]', shown && 'text-fg', className)}
      aria-pressed={shown} title={shown ? 'Hide the browser' : 'Show the browser'}
      onClick={onToggle}>
      <Icon icon="monitor" size={12} aria-hidden="true" />
      Browser
      {open && <span aria-hidden className="size-[6px] bg-accent" />}
    </button>
  )
}
