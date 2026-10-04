import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest'
import { Ghostty, InputHandler, Terminal } from 'ghostty-web'
import { attachTerminalInput } from '../apps/web/src/terminal-input'

let ghostty: Ghostty
const cleanup: Array<() => void> = []

beforeAll(async () => {
  const require = createRequire(import.meta.url)
  const bytes = await readFile(require.resolve('ghostty-web/ghostty-vt.wasm'))
  const { instance } = await WebAssembly.instantiate(new Uint8Array(bytes), { env: { log: vi.fn() } })
  ghostty = new Ghostty(instance)
})

afterEach(() => {
  for (const dispose of cleanup.splice(0).reverse()) dispose()
})

class TerminalElement extends EventTarget {
  override removeEventListener(type: string, callback: EventListenerOrEventListenerObject | null, options?: EventListenerOptions | boolean): void {
    super.removeEventListener(type, callback, typeof options === 'boolean' ? { capture: options } : options)
  }
}

function fixture({ selection = '', bracketedPaste = false, cols = 80, rows = 24 }: { selection?: string; bracketedPaste?: boolean; cols?: number; rows?: number } = {}) {
  const element = new TerminalElement() as unknown as HTMLElement
  const data: string[] = []
  const writeText = vi.fn(async (_text: string): Promise<void> => {})
  const onError = vi.fn<(error: unknown) => void>()
  const wasmTerm = ghostty.createTerminal(cols, rows)
  wasmTerm.write('\x1b[2J\x1b[H')
  if (bracketedPaste) wasmTerm.write('\x1b[?2004h')
  const terminal = new Terminal({ ghostty, cols, rows })
  Object.assign(terminal, { isOpen: true, wasmTerm })
  const subscription = terminal.onData((value) => { data.push(value) })
  vi.spyOn(terminal, 'getSelection').mockReturnValue(selection)
  vi.spyOn(terminal, 'getSelectionPosition').mockReturnValue(undefined)
  vi.spyOn(terminal, 'hasSelection').mockReturnValue(selection.length > 0)
  vi.spyOn(terminal, 'input')
  vi.spyOn(terminal, 'paste')
  vi.stubGlobal('navigator', { clipboard: { writeText } })
  const detach = attachTerminalInput(element, terminal, onError)
  const encoder = ghostty.createKeyEncoder()
  const inputHandler = new InputHandler(
    { createKeyEncoder: () => encoder } as Ghostty,
    element,
    (value) => { data.push(value) },
    () => {}
  )
  element.addEventListener('beforeinput', (event) => event.preventDefault())
  cleanup.push(() => {
    detach()
    inputHandler.dispose()
    encoder.dispose()
    subscription.dispose()
    wasmTerm.free()
  })
  return { element, terminal, wasmTerm, data, writeText, onError, detach }
}

function keyEvent(properties: Partial<KeyboardEvent> = {}): KeyboardEvent {
  return Object.assign(new Event('keydown', { bubbles: true, cancelable: true }), {
    key: 'c',
    code: 'KeyC',
    keyCode: 0,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    isComposing: false,
    ...properties
  }) as KeyboardEvent
}

function clipboardEvent(type: 'copy' | 'paste', value: string) {
  const clipboardData = {
    getData: vi.fn((format: string) => format === 'text/plain' ? value : ''),
    setData: vi.fn<(format: string, text: string) => void>()
  }
  const event = Object.assign(new Event(type, { bubbles: true, cancelable: true }), { clipboardData }) as unknown as ClipboardEvent
  return { event, clipboardData }
}

function beforeInputEvent(inputType: string, data: string | null, properties: Partial<InputEvent> = {}): InputEvent {
  return Object.assign(new Event('beforeinput', { bubbles: true, cancelable: true }), {
    inputType,
    data,
    dataTransfer: null,
    isComposing: false,
    ...properties
  }) as InputEvent
}

describe('terminal clipboard input', () => {
  test.each([
    ['Ctrl+C', { ctrlKey: true }],
    ['Ctrl+Shift+C', { ctrlKey: true, shiftKey: true, key: 'C' }],
    ['Command+C', { metaKey: true }]
  ])('%s copies the selected authentication URL without sending an interrupt', async (_shortcut, modifiers) => {
    const selection = 'https://claude.ai/oauth/authorize?code=example'
    const { element, data, writeText, onError } = fixture({ selection })
    const event = keyEvent(modifiers)

    element.dispatchEvent(event)
    await Promise.resolve()

    expect(writeText).toHaveBeenCalledExactlyOnceWith(selection)
    expect(event.defaultPrevented).toBe(true)
    expect(data).toEqual([])
    expect(onError).not.toHaveBeenCalled()
  })

  test('Ctrl+C without a selection still interrupts the running command', () => {
    const { element, data, writeText } = fixture()

    element.dispatchEvent(keyEvent({ ctrlKey: true }))

    expect(data).toEqual(['\x03'])
    expect(writeText).not.toHaveBeenCalled()
  })

  test('Ctrl+C over a whitespace selection never interrupts the command', () => {
    const { element, terminal, data, writeText } = fixture()
    vi.mocked(terminal.hasSelection).mockReturnValue(true)

    element.dispatchEvent(keyEvent({ ctrlKey: true }))

    expect(data).toEqual([])
    expect(writeText).not.toHaveBeenCalled()
  })

  test.each([
    ['Ctrl+Shift+C', { ctrlKey: true, shiftKey: true }],
    ['Command+C', { metaKey: true }]
  ])('%s with no selection never interrupts the authentication command', (_shortcut, modifiers) => {
    const { element, data, writeText } = fixture()
    const event = keyEvent(modifiers)

    element.dispatchEvent(event)

    expect(event.defaultPrevented).toBe(true)
    expect(data).toEqual([])
    expect(writeText).not.toHaveBeenCalled()
  })

  test('a browser copy event receives the terminal selection', () => {
    const selection = 'https://claude.ai/oauth/authorize?code=example'
    const { element, data } = fixture({ selection })
    const { event, clipboardData } = clipboardEvent('copy', '')
    const downstreamCopy = vi.fn()
    element.addEventListener('copy', downstreamCopy)

    element.dispatchEvent(event)

    expect(clipboardData.setData).toHaveBeenCalledExactlyOnceWith('text/plain', selection)
    expect(event.defaultPrevented).toBe(true)
    expect(downstreamCopy).not.toHaveBeenCalled()
    expect(data).toEqual([])
  })

  test('a URL wrapped across narrow terminal rows copies as one line', () => {
    const url = 'https://claude.ai/oauth/authorize?code=example&state=example'
    const { element, terminal, wasmTerm, data } = fixture({ cols: 20 })
    wasmTerm.write(url)
    const selection = [0, 1, 2].map((row) => terminal.buffer.active.getLine(row)?.translateToString(true)).join('\n')
    vi.mocked(terminal.getSelection).mockReturnValue(selection)
    vi.mocked(terminal.getSelectionPosition).mockReturnValue({ start: { x: 0, y: 0 }, end: { x: 17, y: 2 } })
    const { event, clipboardData } = clipboardEvent('copy', '')

    element.dispatchEvent(event)

    expect(clipboardData.setData).toHaveBeenCalledExactlyOnceWith('text/plain', url)
    expect(data).toEqual([])
  })

  test('copy retains actual terminal line breaks around a wrapped URL', () => {
    const url = 'https://claude.ai/oauth/authorize?code=example&state=example'
    const { element, terminal, wasmTerm } = fixture({ cols: 20 })
    wasmTerm.write(`Open this URL:\r\n${url}\r\nThen paste the code.`)
    const selection = [0, 1, 2, 3, 4].map((row) => terminal.buffer.active.getLine(row)?.translateToString(true)).join('\n')
    vi.mocked(terminal.getSelection).mockReturnValue(selection)
    vi.mocked(terminal.getSelectionPosition).mockReturnValue({ start: { x: 0, y: 0 }, end: { x: 19, y: 4 } })
    const { event, clipboardData } = clipboardEvent('copy', '')

    element.dispatchEvent(event)

    expect(clipboardData.setData).toHaveBeenCalledExactlyOnceWith('text/plain', `Open this URL:\n${url}\nThen paste the code.`)
  })

  test('copy resolves viewport selection rows after earlier output enters scrollback', () => {
    const url = 'https://claude.ai/oauth/authorize?code=example&state=example'
    const { element, terminal, wasmTerm } = fixture({ cols: 20, rows: 4 })
    wasmTerm.write(`Earlier output\r\nEarlier output\r\nEarlier output\r\nEarlier output\r\n${url}\r\nPaste code:`)
    const scrollback = wasmTerm.getScrollbackLength()
    expect(scrollback).toBeGreaterThan(0)
    const selection = [0, 1, 2].map((row) => terminal.buffer.active.getLine(scrollback + row)?.translateToString(true)).join('\n')
    vi.mocked(terminal.getSelection).mockReturnValue(selection)
    vi.mocked(terminal.getSelectionPosition).mockReturnValue({ start: { x: 0, y: 0 }, end: { x: 17, y: 2 } })
    const { event, clipboardData } = clipboardEvent('copy', '')

    element.dispatchEvent(event)

    expect(clipboardData.setData).toHaveBeenCalledExactlyOnceWith('text/plain', url)
  })

  test.each([false, true])('paste reaches the PTY once with normalized line breaks when bracketed paste is %s', (bracketedPaste) => {
    const { element, terminal, data } = fixture({ bracketedPaste })
    const { event } = clipboardEvent('paste', 'oauth-code\r\nsecond-line\nthird-line\rfourth-line')
    const downstreamPaste = vi.fn()
    element.addEventListener('paste', downstreamPaste)

    element.dispatchEvent(event)

    const expected = 'oauth-code\rsecond-line\rthird-line\rfourth-line'
    expect(terminal.paste).toHaveBeenCalledExactlyOnceWith(expected)
    expect(data).toEqual([bracketedPaste ? `\x1b[200~${expected}\x1b[201~` : expected])
    expect(event.defaultPrevented).toBe(true)
    expect(downstreamPaste).not.toHaveBeenCalled()
    expect(terminal.input).not.toHaveBeenCalled()
  })

  test.each(['data', 'dataTransfer'])('beforeinput paste uses %s when the browser omits a paste event', (source) => {
    const { element, terminal, data } = fixture({ bracketedPaste: true })
    const value = 'oauth-code\r\nnext-line\n'
    const event = beforeInputEvent('insertFromPaste', source === 'data' ? value : null, source === 'dataTransfer' ? {
      dataTransfer: { getData: (format: string) => format === 'text/plain' ? value : '' } as DataTransfer
    } : {})

    element.dispatchEvent(event)

    expect(terminal.paste).toHaveBeenCalledExactlyOnceWith('oauth-code\rnext-line\r')
    expect(data).toEqual(['\x1b[200~oauth-code\rnext-line\r\x1b[201~'])
    expect(event.defaultPrevented).toBe(true)
    expect(terminal.input).not.toHaveBeenCalled()
  })

  test('copy failure reports the clipboard error without interrupting the command', async () => {
    const { element, data, writeText, onError } = fixture({ selection: 'authentication-url' })
    const error = new Error('Clipboard access denied')
    writeText.mockRejectedValueOnce(error)

    element.dispatchEvent(keyEvent({ ctrlKey: true }))
    await vi.waitFor(() => expect(onError).toHaveBeenCalledExactlyOnceWith(error))

    expect(data).toEqual([])
  })

  test('copy uses the browser copy event when the clipboard API is unavailable', async () => {
    const selection = 'authentication-url'
    const { element, data, onError } = fixture({ selection })
    const { event, clipboardData } = clipboardEvent('copy', '')
    const execCommand = vi.fn(() => {
      element.dispatchEvent(event)
      return true
    })
    vi.stubGlobal('navigator', {})
    vi.stubGlobal('document', { execCommand })

    element.dispatchEvent(keyEvent({ metaKey: true }))
    await Promise.resolve()

    expect(execCommand).toHaveBeenCalledExactlyOnceWith('copy')
    expect(clipboardData.setData).toHaveBeenCalledExactlyOnceWith('text/plain', selection)
    expect(data).toEqual([])
    expect(onError).not.toHaveBeenCalled()
  })

  test('detaching removes the clipboard and virtual keyboard bridge', () => {
    const { element, terminal, data, writeText, detach } = fixture({ selection: 'authentication-url' })
    detach()
    const { event: copy, clipboardData } = clipboardEvent('copy', '')
    const { event: paste } = clipboardEvent('paste', 'oauth-code\n')

    element.dispatchEvent(keyEvent({ ctrlKey: true }))
    element.dispatchEvent(copy)
    element.dispatchEvent(paste)
    element.dispatchEvent(beforeInputEvent('insertText', 'virtual-text'))

    expect(data).toEqual(['\x03', 'oauth-code\n'])
    expect(writeText).not.toHaveBeenCalled()
    expect(clipboardData.setData).not.toHaveBeenCalled()
    expect(terminal.paste).not.toHaveBeenCalled()
    expect(terminal.input).not.toHaveBeenCalled()
  })
})

describe('terminal virtual keyboard input', () => {
  test.each(['', 'Enter', 'NumpadEnter'])('Enter with code "%s" reaches the PTY once', (code) => {
    const { element, data } = fixture()

    element.dispatchEvent(keyEvent({ key: 'Enter', code }))

    expect(data).toEqual(['\r'])
  })

  test.each([
    ['insertText', 'oauth-code', 'oauth-code'],
    ['insertLineBreak', null, '\r'],
    ['insertParagraph', null, '\r'],
    ['deleteContentBackward', null, '\x7f'],
    ['deleteContentForward', null, '\x1b[3~']
  ])('%s reaches the PTY once before Ghostty cancels the editing event', (inputType, value, expected) => {
    const { element, terminal, data } = fixture()
    const event = beforeInputEvent(inputType, value)

    element.dispatchEvent(event)

    expect(terminal.input).toHaveBeenCalledExactlyOnceWith(expected, true)
    expect(data).toEqual([expected])
    expect(event.defaultPrevented).toBe(true)
  })

  test('composition and already handled editing events do not send partial or duplicate text', () => {
    const { element, terminal, data } = fixture()
    const handled = beforeInputEvent('insertText', 'duplicate')
    handled.preventDefault()

    element.dispatchEvent(handled)
    element.dispatchEvent(beforeInputEvent('insertText', 'partial', { isComposing: true }))

    expect(terminal.input).not.toHaveBeenCalled()
    expect(data).toEqual([])
  })
})
