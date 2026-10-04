import { useEffect, useRef, useState, type JSX } from 'react'
import { btn, cn, field } from '../ui'

export function TerminalAuthInput({ sessionId }: { sessionId: string }): JSX.Element {
  const [code, setCode] = useState('')
  const [sending, setSending] = useState(false)
  const [sent, setSent] = useState(false)
  const [isComposing, setIsComposing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const pending = useRef(false)
  const composing = useRef(false)
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  const send = async (): Promise<void> => {
    const value = code.trim()
    if (!value || pending.current || composing.current) return
    pending.current = true
    setSending(true)
    setSent(false)
    setError(null)
    try {
      await window.anvil.terminals.write({ sessionId, data: `${value}\r` })
      if (mounted.current) setSent(true)
    } catch {
      if (mounted.current) setError('Could not send the sign-in code. Your code is still here. Retry when the terminal is ready.')
    } finally {
      pending.current = false
      if (mounted.current) setSending(false)
    }
  }

  return <form className="mt-3" onSubmit={(event) => { event.preventDefault(); void send() }}>
    <label className={field.wrap}>
      <span className={field.label}>Claude sign-in code</span>
      <input
        type="text"
        className={cn(field.sized, 'font-mono text-base')}
        placeholder="Paste the code from the browser"
        autoCapitalize="none"
        autoCorrect="off"
        autoComplete="off"
        spellCheck={false}
        enterKeyHint="send"
        maxLength={65535}
        value={code}
        readOnly={sending}
        onChange={(event) => { setCode(event.target.value); setSent(false) }}
        onCompositionStart={() => { composing.current = true; setIsComposing(true) }}
        onCompositionEnd={() => { composing.current = false; setIsComposing(false) }}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229)) event.preventDefault()
        }}
      />
    </label>
    <div className="flex items-center gap-2">
      <button type="submit" className={btn.primary} disabled={!code.trim() || sending || isComposing}>Send code</button>
      <p className="text-xs text-dim">Paste the browser code above, review it, then send it to Claude Code.</p>
    </div>
    {sent && <p role="status" className="mt-2 text-xs text-dim">Code sent to Claude Code.</p>}
    {error && <p role="alert" className="mt-2 text-xs text-danger">{error}</p>}
  </form>
}
