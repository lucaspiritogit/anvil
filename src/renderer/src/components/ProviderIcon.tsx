import type { JSX } from 'react'
import { HugeiconsIcon } from '@hugeicons/react'
import { ClaudeIcon, GoogleGeminiIcon, GridViewIcon } from '@hugeicons/core-free-icons'
import openaiMark from '@public/providers/openai.svg'
import openrouterMark from '@public/providers/openrouter.svg'
import opencodeMark from '@public/agents/opencode.svg'

export function ProviderIcon({ company, size = 18 }: { company: string; size?: number }): JSX.Element {
  if (company === 'OpenCode Go' || company === 'OpenCode Zen') {
    return <img src={opencodeMark} alt="" aria-hidden="true" width={size} height={size} className="shrink-0 rounded-sm" />
  }
  if (company === 'OpenAI' || company === 'OpenRouter' || company === 'Codex') {
    const artwork = company === 'OpenRouter' ? openrouterMark : openaiMark
    return (
      <span
        aria-hidden="true"
        className="inline-block shrink-0 bg-current"
        style={{ width: size, height: size, mask: `url("${artwork}") center / contain no-repeat` }}
      />
    )
  }
  if (company === 'Anthropic' || company === 'Google') {
    return (
      <HugeiconsIcon
        icon={company === 'Anthropic' ? ClaudeIcon : GoogleGeminiIcon}
        size={size}
        className={company === 'Anthropic' ? 'shrink-0 text-[#d48b70]' : 'shrink-0 text-accent'}
        aria-hidden="true"
      />
    )
  }
  if (!company) return <HugeiconsIcon icon={GridViewIcon} size={size} className="shrink-0" aria-hidden="true" />
  return <span aria-hidden="true" className="grid shrink-0 place-items-center text-xs font-semibold" style={{ width: size, height: size }}>{company.slice(0, 2).toUpperCase()}</span>
}
