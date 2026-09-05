/**
 * Keyboard shortcuts are stored as accelerator strings ("Mod+B") so a binding
 * survives a settings round-trip through SQLite and reads the same on every
 * platform. `Mod` is Command on macOS and Control everywhere else, which is
 * what makes one stored binding correct for both.
 */

export type ShortcutId = 'toggleSidebar'

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

/** Display form: the mac symbols developers expect, spelled out elsewhere. */
export function formatAccelerator(accelerator: string, isMac: boolean): string {
  const chord = parseAccelerator(accelerator)
  if (!chord) return accelerator
  const parts: string[] = []
  if (chord.mod) parts.push(isMac ? '⌘' : 'Ctrl')
  if (chord.ctrl) parts.push(isMac ? '⌃' : 'Ctrl')
  if (chord.alt) parts.push(isMac ? '⌥' : 'Alt')
  if (chord.shift) parts.push(isMac ? '⇧' : 'Shift')
  parts.push(chord.key)
  return isMac ? parts.join('') : parts.join('+')
}
