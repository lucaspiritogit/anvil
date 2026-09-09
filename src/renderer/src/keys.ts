import { parseAccelerator } from '@shared/keybindings'

/**
 * Matching a key press against a stored accelerator. This lives in the
 * renderer because it speaks DOM events; the accelerator grammar itself is
 * shared with the main process, which persists the bindings.
 */

/** True on macOS, where the primary modifier is Command rather than Control. */
export const IS_MAC = window.anvil.platform === 'darwin'

export function isTerminalShortcut(event: KeyboardEvent): boolean {
  return (event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey &&
    (event.code === 'KeyT' || event.key.toLowerCase() === 't')
}

/**
 * Physical keys, so Alt combinations still resolve on layouts where the
 * modifier rewrites the character (Alt+B is `∫` on macOS).
 */
function keyOf(event: KeyboardEvent): string | null {
  if (/^Key[A-Z]$/.test(event.code)) return event.code.slice(3)
  if (/^Digit[0-9]$/.test(event.code)) return event.code.slice(5)
  if (/^F\d{1,2}$/.test(event.key)) return event.key
  if (event.key === ' ') return 'Space'
  if (event.key.length === 1) return event.key.toUpperCase()
  if (/^(Enter|Escape|Backspace|Tab|Home|End|PageUp|PageDown|Arrow(Up|Down|Left|Right))$/.test(event.key)) {
    return event.key
  }
  return null
}

export function matchesAccelerator(event: KeyboardEvent, accelerator: string): boolean {
  const chord = parseAccelerator(accelerator)
  if (!chord) return false
  const key = keyOf(event)
  if (!key || key.toUpperCase() !== chord.key.toUpperCase()) return false
  const primary = IS_MAC ? event.metaKey : event.ctrlKey
  const secondary = IS_MAC ? event.ctrlKey : event.metaKey
  return (
    primary === chord.mod &&
    secondary === chord.ctrl &&
    event.altKey === chord.alt &&
    event.shiftKey === chord.shift
  )
}

/**
 * The chord a key press would bind to, or null when it is not bindable — a
 * lone modifier, or a key with no modifier at all, which would swallow typing.
 */
export function acceleratorFromEvent(event: KeyboardEvent): string | null {
  const key = keyOf(event)
  if (!key) return null
  const primary = IS_MAC ? event.metaKey : event.ctrlKey
  const secondary = IS_MAC ? event.ctrlKey : event.metaKey
  const tokens: string[] = []
  if (primary) tokens.push('Mod')
  if (secondary) tokens.push('Ctrl')
  if (event.altKey) tokens.push('Alt')
  if (event.shiftKey) tokens.push('Shift')
  if (!tokens.length) return null
  tokens.push(key)
  return tokens.join('+')
}
