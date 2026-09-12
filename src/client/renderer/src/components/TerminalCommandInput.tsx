import { useRef, useState, type JSX } from 'react'
import { btn, cn, field } from '../ui'

export function TerminalCommandInput({ sessionId, disabled }: {
  sessionId: string
  disabled: boolean
}): JSX.Element {
  const input = useRef<HTMLInputElement>(null)
  const pending = useRef(false)
  const composing = useRef(false)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const send = async (interrupt: boolean): Promise<void> => {
    const field = input.current
    if (!field || disabled || pending.current || composing.current) return
    const command = field.value
    pending.current = true
    setSending(true)
    setError(null)
    try {
      await window.anvil.terminals.write({ sessionId, data: interrupt ? '\x03' : `${command}\r` })
      if (input.current === field) field.value = ''
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Could not send terminal input')
    } finally {
      pending.current = false
      setSending(false)
    }
  }

  return <form
    aria-label="Terminal command"
    className="shrink-0 border-t border-line pt-2"
    onSubmit={(event) => { event.preventDefault(); void send(false) }}
  >
    <div className="flex items-center gap-2">
      <input
        ref={input}
        type="text"
        aria-label="Terminal command"
        placeholder="Type a command"
        className={cn(field.control, 'min-w-0 px-2 py-2 font-mono text-base')}
        autoCapitalize="none"
        autoCorrect="off"
        autoComplete="off"
        spellCheck={false}
        enterKeyHint="send"
        maxLength={65535}
        readOnly={sending}
        disabled={disabled}
        onCompositionStart={() => { composing.current = true }}
        onCompositionEnd={() => { composing.current = false }}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229)) event.preventDefault()
        }}
      />
      <button type="submit" className={cn(btn.primary, 'min-h-11 text-xs')} disabled={disabled || sending}>Send</button>
      <button type="button" aria-label="Interrupt terminal command" className={cn(btn.ghost, 'min-h-11 text-xs')} disabled={disabled || sending} onClick={() => void send(true)}>Ctrl+C</button>
    </div>
    {error && <p role="alert" className="mt-1 text-xs text-danger">{error}</p>}
  </form>
}
