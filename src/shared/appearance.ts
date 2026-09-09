/** Matches the existing renderer canvas. Keep the saved color when switching modes. */
export const DEFAULT_FONT_SIZE = 14
export const MIN_FONT_SIZE = 12
export const MAX_FONT_SIZE = 18

export function normalizeFontSize(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= MIN_FONT_SIZE && value <= MAX_FONT_SIZE
    ? value : DEFAULT_FONT_SIZE
}

export const DEFAULT_OVERVIEW_COLOR = '#0d0f12'
export const OVERVIEW_COLOR_PATTERN = /^#[0-9a-fA-F]{6}$(?![\s\S])/
export const WALLPAPER_ID_PATTERN = /^(?![.])(?!.*[\\/:\x00-\x1f\x7f])[^\n]{1,255}\.(?:png|jpe?g|webp)$/i

export function isWallpaperId(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 255 && WALLPAPER_ID_PATTERN.test(value)
}
