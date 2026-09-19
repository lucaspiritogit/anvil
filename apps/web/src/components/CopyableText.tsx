import { useEffect, useState, type JSX } from 'react'
import { Icon } from '../icons'
import { btn, cn } from '../ui'

export function CopyableText({ label, value }: { label: string; value: string }): JSX.Element {
  const [feedback, setFeedback] = useState('')

  useEffect(() => {
    setFeedback('')
  }, [value])

  useEffect(() => {
    if (!feedback) return
    const timer = window.setTimeout(() => setFeedback(''), 2500)
    return () => window.clearTimeout(timer)
  }, [feedback])

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(value)
      setFeedback(`Copied ${label}`)
    } catch {
      setFeedback(`Could not copy ${label}. Select the text to copy it manually.`)
    }
  }

  return (
    <span className="relative inline-flex min-w-0 items-center gap-1.5">
      <code className="truncate select-text text-[11px]" title={value}>{value}</code>
      <button
        type="button"
        className={cn(btn.icon, 'grid shrink-0 place-items-center')}
        aria-label={`Copy ${label}`}
        title={`Copy ${label}`}
        onClick={() => void copy()}
      >
        <Icon icon="copy" size={14} aria-hidden="true" />
      </button>
      <span role="status" className={feedback ? 'absolute right-0 bottom-full z-10 mb-1 w-max max-w-64 border border-line bg-hover px-2 py-1 text-xs text-fg shadow-lg' : 'sr-only'}>
        {feedback}
      </span>
    </span>
  )
}
