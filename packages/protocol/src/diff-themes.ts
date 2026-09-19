/** Shiki themes for the diff renderer, split by colour scheme. */
export interface DiffThemes {
  dark: string
  light: string
}

export const DEFAULT_DIFF_THEMES: DiffThemes = {
  dark: 'pierre-dark',
  light: 'pierre-light'
}

/** Every bundled theme offered in the display settings, plus Diffs' own pair. */
export const DIFF_THEME_NAMES = [
  'pierre-dark',
  'pierre-light',
  'andromeeda',
  'aurora-x',
  'ayu-dark',
  'ayu-light',
  'ayu-mirage',
  'catppuccin-frappe',
  'catppuccin-latte',
  'catppuccin-macchiato',
  'catppuccin-mocha',
  'dark-plus',
  'dracula',
  'dracula-soft',
  'everforest-dark',
  'everforest-light',
  'github-dark',
  'github-dark-default',
  'github-dark-dimmed',
  'github-dark-high-contrast',
  'github-light',
  'github-light-default',
  'github-light-high-contrast',
  'gruvbox-dark-hard',
  'gruvbox-dark-medium',
  'gruvbox-dark-soft',
  'gruvbox-light-hard',
  'gruvbox-light-medium',
  'gruvbox-light-soft',
  'horizon',
  'horizon-bright',
  'houston',
  'kanagawa-dragon',
  'kanagawa-lotus',
  'kanagawa-wave',
  'laserwave',
  'light-plus',
  'material-theme',
  'material-theme-darker',
  'material-theme-lighter',
  'material-theme-ocean',
  'material-theme-palenight',
  'min-dark',
  'min-light',
  'monokai',
  'night-owl',
  'night-owl-light',
  'nord',
  'one-dark-pro',
  'one-light',
  'plastic',
  'poimandres',
  'red',
  'rose-pine',
  'rose-pine-dawn',
  'rose-pine-moon',
  'slack-dark',
  'slack-ochin',
  'snazzy-light',
  'solarized-dark',
  'solarized-light',
  'synthwave-84',
  'tokyo-night',
  'vesper',
  'vitesse-black',
  'vitesse-dark',
  'vitesse-light'
] as const

export type DiffThemeName = (typeof DIFF_THEME_NAMES)[number]

const DIFF_THEME_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/

export function isDiffThemeName(value: unknown): value is string {
  return typeof value === 'string' && DIFF_THEME_NAME.test(value)
}

export function normalizeDiffThemes(value: unknown): DiffThemes {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ...DEFAULT_DIFF_THEMES }
  const record = value as Record<string, unknown>
  return {
    dark: isDiffThemeName(record.dark) ? record.dark : DEFAULT_DIFF_THEMES.dark,
    light: isDiffThemeName(record.light) ? record.light : DEFAULT_DIFF_THEMES.light
  }
}