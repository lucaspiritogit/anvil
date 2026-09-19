const ASCII_RAMP = ' .:-=+*#%@'
const HALFTONE_CELL = 5
const ASCII_CELL = 12

interface Rgb {
  r: number
  g: number
  b: number
}

function parseColor(hex: string): Rgb {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  if (!match) return { r: 13, g: 15, b: 18 }
  const value = parseInt(match[1], 16)
  return { r: (value >> 16) & 255, g: (value >> 8) & 255, b: value & 255 }
}

function rgba(color: Rgb, alpha: number): string {
  return `rgba(${color.r}, ${color.g}, ${color.b}, ${alpha})`
}

function coverRect(image: HTMLImageElement, width: number, height: number): [number, number, number, number] {
  const scale = Math.max(width / image.naturalWidth, height / image.naturalHeight)
  const drawWidth = image.naturalWidth * scale
  const drawHeight = image.naturalHeight * scale
  return [(width - drawWidth) / 2, (height - drawHeight) / 2, drawWidth, drawHeight]
}

function sampleLuminance(image: HTMLImageElement, width: number, height: number, cell: number): { cols: number; rows: number; values: Float32Array } | null {
  const cols = Math.ceil(width / cell)
  const rows = Math.ceil(height / cell)
  const sampler = document.createElement('canvas')
  sampler.width = cols
  sampler.height = rows
  const ctx = sampler.getContext('2d', { willReadFrequently: true })
  if (!ctx) return null
  const rect = coverRect(image, width, height)
  ctx.drawImage(image, rect[0] / cell, rect[1] / cell, rect[2] / cell, rect[3] / cell)
  const data = ctx.getImageData(0, 0, cols, rows).data
  const values = new Float32Array(cols * rows)
  for (let i = 0; i < values.length; i++) {
    const offset = i * 4
    values[i] = (0.2126 * data[offset] + 0.7152 * data[offset + 1] + 0.0722 * data[offset + 2]) / 255
  }
  return { cols, rows, values }
}

function drawHalftone(ctx: CanvasRenderingContext2D, image: HTMLImageElement, width: number, height: number, ink: Rgb): void {
  const grid = sampleLuminance(image, width, height, HALFTONE_CELL)
  if (!grid) return
  ctx.fillStyle = rgba(ink, 0.6)
  ctx.beginPath()
  for (let row = 0; row < grid.rows; row++) {
    for (let col = 0; col < grid.cols; col++) {
      const lum = grid.values[row * grid.cols + col]
      const radius = HALFTONE_CELL * (0.16 + 0.3 * (1 - lum))
      const x = col * HALFTONE_CELL + HALFTONE_CELL / 2
      const y = row * HALFTONE_CELL + HALFTONE_CELL / 2
      ctx.moveTo(x + radius, y)
      ctx.arc(x, y, radius, 0, Math.PI * 2)
    }
  }
  ctx.fill()
}

function drawAscii(ctx: CanvasRenderingContext2D, image: HTMLImageElement, width: number, height: number): void {
  const grid = sampleLuminance(image, width, height, ASCII_CELL)
  if (!grid) return
  ctx.font = `${ASCII_CELL - 1}px ui-monospace, SFMono-Regular, Menlo, monospace`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  for (let row = 0; row < grid.rows; row++) {
    for (let col = 0; col < grid.cols; col++) {
      const lum = grid.values[row * grid.cols + col]
      if (lum < 0.18) continue
      const glyph = ASCII_RAMP[Math.min(ASCII_RAMP.length - 1, Math.floor(lum * ASCII_RAMP.length))]
      if (glyph === ' ') continue
      ctx.fillStyle = `rgba(215, 219, 224, ${0.05 + 0.13 * lum})`
      ctx.fillText(glyph, col * ASCII_CELL + ASCII_CELL / 2, row * ASCII_CELL + ASCII_CELL / 2)
    }
  }
}

function drawGradient(ctx: CanvasRenderingContext2D, width: number, height: number, ink: Rgb): void {
  ctx.fillStyle = rgba(ink, 0.35)
  ctx.fillRect(0, 0, width, height)
  const gradient = ctx.createLinearGradient(0, 0, 0, height)
  gradient.addColorStop(0, rgba(ink, 0.15))
  gradient.addColorStop(0.45, rgba(ink, 0.3))
  gradient.addColorStop(0.75, rgba(ink, 0.8))
  gradient.addColorStop(1, rgba(ink, 0.97))
  ctx.fillStyle = gradient
  ctx.fillRect(0, 0, width, height)
}

export function renderWallpaper(canvas: HTMLCanvasElement, image: HTMLImageElement, width: number, height: number, baseColor: string): void {
  if (width <= 0 || height <= 0 || !image.naturalWidth || !image.naturalHeight) return
  const dpr = Math.min(window.devicePixelRatio || 1, 2)
  canvas.width = Math.round(width * dpr)
  canvas.height = Math.round(height * dpr)
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  const ink = parseColor(baseColor)
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.fillStyle = rgba(ink, 1)
  ctx.fillRect(0, 0, width, height)
  ctx.drawImage(image, ...coverRect(image, width, height))
  drawHalftone(ctx, image, width, height, ink)
  drawAscii(ctx, image, width, height)
  drawGradient(ctx, width, height, ink)
}
