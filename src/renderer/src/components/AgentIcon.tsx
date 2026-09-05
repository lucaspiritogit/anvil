import type { JSX } from 'react'
import opencodeMark from '@public/agents/opencode.svg'

/**
 * Logo marks live in /public so they can be reused anywhere in the app (and by
 * anything else that needs the raw file). Agents without a mark fall back to a
 * monogram, so a new agent never renders a broken image.
 */
const MARKS: Record<string, string> = {
  opencode: opencodeMark
}

export function AgentIcon({
  agentId,
  label,
  size = 20
}: {
  agentId: string
  label: string
  size?: number
}): JSX.Element {
  const mark = MARKS[agentId]
  const style = { width: size, height: size }
  if (mark) return <img className="flex-none rounded-md" src={mark} alt="" style={style} />
  return (
    <span
      className="flex-none rounded-md grid place-items-center text-xs font-semibold text-dim bg-raised border border-line"
      style={style}
      aria-hidden
    >
      {label.charAt(0).toUpperCase()}
    </span>
  )
}
