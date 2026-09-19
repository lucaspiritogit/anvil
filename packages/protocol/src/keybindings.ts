export type ShortcutId = 'toggleSidebar' | 'focusTaskComposer' | 'cycleTaskStyle' | 'cycleReviewPolicy' | 'cycleThinking'

export interface ShortcutDefinition {
  id: ShortcutId
  label: string
  hint: string
  defaultAccelerator: string
}

export const SHORTCUTS: ShortcutDefinition[] = [
  {
    id: 'toggleSidebar',
    label: 'Toggle sidebar',
    hint: 'Slides the project sidebar out of the way and back.',
    defaultAccelerator: 'Mod+B'
  },
  {
    id: 'focusTaskComposer',
    label: 'Focus task composer',
    hint: 'Opens the project overview and focuses the new task prompt.',
    defaultAccelerator: 'Mod+N'
  },
  {
    id: 'cycleTaskStyle',
    label: 'Cycle task style',
    hint: 'Switches the composer between Work and Quick.',
    defaultAccelerator: 'Mod+Shift+M'
  },
  {
    id: 'cycleReviewPolicy',
    label: 'Cycle review policy',
    hint: 'Switches the composer between Review each step and Review at the end.',
    defaultAccelerator: 'Mod+Shift+I'
  },
  {
    id: 'cycleThinking',
    label: 'Cycle thinking',
    hint: 'Advances the composer thinking level, wrapping back to the first at the maximum.',
    defaultAccelerator: 'Mod+Shift+T'
  }
]

export type Keybindings = Record<ShortcutId, string>

export const DEFAULT_KEYBINDINGS: Keybindings = SHORTCUTS.reduce<Keybindings>(
  (bindings, shortcut) => ({ ...bindings, [shortcut.id]: shortcut.defaultAccelerator }),
  {} as Keybindings
)

/** A stored binding may be missing or malformed; the default fills the gap. */
export function normalizeKeybindings(value: unknown): Keybindings {
  const stored = typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
  return SHORTCUTS.reduce<Keybindings>((bindings, shortcut) => {
    const binding = stored[shortcut.id]
    bindings[shortcut.id] =
      typeof binding === 'string' && binding.trim() ? binding : shortcut.defaultAccelerator
    return bindings
  }, {} as Keybindings)
}

export interface Chord {
  mod: boolean
  ctrl: boolean
  alt: boolean
  shift: boolean
  key: string
}

export function parseAccelerator(accelerator: string): Chord | null {
  const chord: Chord = { mod: false, ctrl: false, alt: false, shift: false, key: '' }
  for (const raw of accelerator.split('+')) {
    const token = raw.trim()
    if (!token) continue
    const lower = token.toLowerCase()
    if (lower === 'mod' || lower === 'cmd' || lower === 'command' || lower === 'meta') {
      chord.mod = true
    } else if (lower === 'ctrl' || lower === 'control') chord.ctrl = true
    else if (lower === 'alt' || lower === 'option') chord.alt = true
    else if (lower === 'shift') chord.shift = true
    else chord.key = token.length === 1 ? token.toUpperCase() : token
  }
  return chord.key ? chord : null
}

export function acceleratorKeycaps(accelerator: string, isMac: boolean): string[] {
  const chord = parseAccelerator(accelerator)
  if (!chord) return [accelerator]
  const parts: string[] = []
  if (chord.mod) parts.push(isMac ? '⌘' : 'Ctrl')
  if (chord.ctrl) parts.push(isMac ? '⌃' : 'Ctrl')
  if (chord.alt) parts.push(isMac ? '⌥' : 'Alt')
  if (chord.shift) parts.push(isMac ? '⇧' : 'Shift')
  parts.push(chord.key)
  return parts
}

export function formatAccelerator(accelerator: string, isMac: boolean): string {
  const parts = acceleratorKeycaps(accelerator, isMac)
  return isMac ? parts.join('') : parts.join('+')
}
