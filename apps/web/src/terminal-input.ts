import type { Terminal } from 'ghostty-web'

/** Bridge virtual keyboards that send editing events instead of physical key codes. */
export function attachTerminalInput(element: HTMLElement, terminal: Terminal): () => void {
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.defaultPrevented || event.isComposing || event.keyCode === 229) return
    if (event.key !== 'Enter' || event.code === 'Enter' || event.code === 'NumpadEnter') return
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
    event.preventDefault()
    event.stopImmediatePropagation()
    terminal.input('\r', true)
  }
  const onBeforeInput = (event: InputEvent): void => {
    if (event.defaultPrevented || event.isComposing) return
    let data: string
    switch (event.inputType) {
      case 'insertLineBreak':
      case 'insertParagraph':
        data = '\r'
        break
      case 'insertText':
        if (!event.data) return
        data = event.data
        break
      case 'deleteContentBackward':
        data = '\x7f'
        break
      case 'deleteContentForward':
        data = '\x1b[3~'
        break
      default:
        return
    }
    event.preventDefault()
    event.stopImmediatePropagation()
    terminal.input(data, true)
  }
  // Capture before ghostty-web cancels beforeinput without forwarding its data.
  // Physical keydowns already prevent the browser's editing event, so those
  // keys continue through Ghostty's encoder without being sent a second time.
  element.addEventListener('keydown', onKeyDown, true)
  element.addEventListener('beforeinput', onBeforeInput, true)
  return () => {
    element.removeEventListener('keydown', onKeyDown, true)
    element.removeEventListener('beforeinput', onBeforeInput, true)
  }
}
