import type { Terminal } from 'ghostty-web'

/** Bridge virtual keyboards that send editing events instead of physical key codes. */
export function attachTerminalInput(element: HTMLElement, terminal: Terminal, onError: (error: unknown) => void): () => void {
  const getSelection = (): string => {
    const selection = terminal.getSelection()
    const position = terminal.getSelectionPosition()
    if (!position || !selection.includes('\n')) return selection
    const lines = selection.split('\n')
    if (lines.length !== position.end.y - position.start.y + 1) return selection
    const buffer = terminal.buffer.active
    const viewportStart = buffer.length - terminal.rows - Math.floor(terminal.getViewportY())
    let text = lines[0]
    for (let index = 1; index < lines.length; index += 1) {
      const line = buffer.getLine(viewportStart + position.start.y + index)
      if (!line?.isWrapped) text += '\n'
      text += lines[index]
    }
    return text
  }
  const copySelection = async (selection: string): Promise<void> => {
    if (!navigator.clipboard?.writeText) {
      if (document.execCommand('copy')) return
      throw new Error('Could not copy terminal text. Use the terminal context menu to copy it.')
    }
    await navigator.clipboard.writeText(selection)
  }
  const paste = (data: string): void => {
    if (data) terminal.paste(data.replace(/\r?\n/g, '\r'))
  }
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.defaultPrevented || event.isComposing || event.keyCode === 229) return
    const copyKey = (event.code === 'KeyC' || event.key.toLowerCase() === 'c') &&
      (event.ctrlKey || event.metaKey) && !event.altKey
    if (copyKey) {
      const selection = getSelection()
      if (selection || terminal.hasSelection() || event.metaKey || event.shiftKey) {
        event.preventDefault()
        event.stopImmediatePropagation()
        if (selection) void copySelection(selection).catch(onError)
        return
      }
    }
    if (event.key !== 'Enter' || event.code === 'Enter' || event.code === 'NumpadEnter') return
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
    event.preventDefault()
    event.stopImmediatePropagation()
    terminal.input('\r', true)
  }
  const onCopy = (event: ClipboardEvent): void => {
    if (event.defaultPrevented || !event.clipboardData) return
    const selection = getSelection()
    if (!selection) return
    event.preventDefault()
    event.stopImmediatePropagation()
    event.clipboardData.setData('text/plain', selection)
  }
  const onPaste = (event: ClipboardEvent): void => {
    if (event.defaultPrevented) return
    event.preventDefault()
    event.stopImmediatePropagation()
    paste(event.clipboardData?.getData('text/plain') ?? '')
  }
  const onBeforeInput = (event: InputEvent): void => {
    if (event.defaultPrevented || event.isComposing) return
    let data: string
    switch (event.inputType) {
      case 'insertFromPaste':
        event.preventDefault()
        event.stopImmediatePropagation()
        paste(event.dataTransfer?.getData('text/plain') || event.data || '')
        return
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
  element.addEventListener('copy', onCopy, true)
  element.addEventListener('paste', onPaste, true)
  element.addEventListener('beforeinput', onBeforeInput, true)
  return () => {
    element.removeEventListener('keydown', onKeyDown, true)
    element.removeEventListener('copy', onCopy, true)
    element.removeEventListener('paste', onPaste, true)
    element.removeEventListener('beforeinput', onBeforeInput, true)
  }
}
