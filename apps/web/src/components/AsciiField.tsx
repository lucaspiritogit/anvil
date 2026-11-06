import type { JSX } from 'react'
import { useEffect, useRef } from 'react'

const RAMP = ['', '.', '·', ':', '+', '*']
const CELL_W = 13
const CELL_H = 18
const FPS = 10
const FADE_IN = 1600

const hash = (x: number, y: number): number => {
  const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453
  return s - Math.floor(s)
}

const smooth = (a: number, b: number, x: number): number => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

const field = (x: number, y: number, t: number): number => {
  const h = hash(x, y)
  const twinkle = Math.pow(Math.max(0, Math.sin(t * (0.06 + h * 0.08) + h * 40)), 40)
  return 0.34 + twinkle * 0.66
}

type Colors = { dot: string; hi: string; font: string }

export function AsciiField(): JSX.Element {
  const ref = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = ref.current
    const ctx = canvas?.getContext('2d')
    if (!canvas || !ctx) return
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    let w = 0
    let h = 0
    let dpr = 1
    let raf = 0
    let last = 0
    let colors: Colors | null = null
    let colorsAt = 0
    const start = performance.now()

    const readColors = (): Colors => {
      const style = getComputedStyle(canvas)
      colorsAt = performance.now()
      return {
        dot: style.getPropertyValue('--color-dim').trim() || '#9aa1ac',
        hi: style.getPropertyValue('--color-accent').trim() || '#f97316',
        font: style.getPropertyValue('--font-mono').trim() || 'monospace',
      }
    }

    const draw = (now: number, force = false): void => {
      if (!w || !h) return
      if (!force && document.hidden) return
      if (!colors || now - colorsAt > 1000) colors = readColors()
      const t = reduce ? 4 : (now - start) / 1000
      const intro = reduce ? 1 : smooth(0, 1, (now - start) / FADE_IN)
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, w, h)
      ctx.font = `12px ${colors.font}`
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      const cols = Math.ceil(w / CELL_W) + 1
      const rows = Math.ceil(h / CELL_H) + 1
      const ox = (w - (cols - 1) * CELL_W) / 2
      const oy = (h - (rows - 1) * CELL_H) / 2
      const cx = w / 2
      const cy = h * 0.46
      const rx = Math.max(340, w * 0.3)
      const ry = Math.max(180, h * 0.26)
      for (let j = 0; j < rows; j++) {
        const py = oy + j * CELL_H
        for (let i = 0; i < cols; i++) {
          const px = ox + i * CELL_W
          const r = Math.hypot((px - cx) / rx, (py - cy) / ry)
          const mask = smooth(0.62, 1.05, r) * (1 - 0.55 * smooth(1.6, 2.6, r)) * intro
          if (mask < 0.02) continue
          const v = field(i, j, t)
          const k = Math.max(0, Math.min(RAMP.length - 1, Math.floor(v * RAMP.length)))
          if (!k) continue
          const hi = v > 0.86
          ctx.globalAlpha = mask * (hi ? 0.75 : 0.22 + v * 0.38)
          ctx.fillStyle = hi ? colors.hi : colors.dot
          ctx.fillText(RAMP[k], px, py)
        }
      }
      ctx.globalAlpha = 1
    }

    const resize = (): void => {
      dpr = Math.min(2, window.devicePixelRatio || 1)
      w = canvas.clientWidth
      h = canvas.clientHeight
      canvas.width = Math.round(w * dpr)
      canvas.height = Math.round(h * dpr)
      draw(performance.now(), true)
    }

    const loop = (now: number): void => {
      raf = requestAnimationFrame(loop)
      if (now - last < 1000 / FPS) return
      last = now
      draw(now)
    }

    const observer = new ResizeObserver(resize)
    observer.observe(canvas)
    resize()
    if (!reduce) raf = requestAnimationFrame(loop)
    return () => {
      cancelAnimationFrame(raf)
      observer.disconnect()
    }
  }, [])

  return (
    <canvas
      ref={ref}
      aria-hidden
      data-testid="overview-ascii-field"
      className="pointer-events-none absolute inset-0 h-full w-full"
    />
  )
}
