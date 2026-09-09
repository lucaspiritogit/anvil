import type { JSX } from 'react'
import { HugeiconsIcon } from '@hugeicons/react'
import { ClaudeIcon, GoogleGeminiIcon, GridViewIcon } from '@hugeicons/core-free-icons'
import openaiMark from '@public/providers/openai.svg'
import openrouterMark from '@public/providers/openrouter.svg'
import opencodeMark from '@public/agents/opencode.svg'
import deepseekMark from '@public/providers/deepseek.svg'
import kimiMark from '@public/providers/kimi.svg'
import grokMark from '@public/providers/grok.svg'

const COLOR_MARKS: Record<string, string> = {
  'OpenCode Go': opencodeMark,
  'OpenCode Zen': opencodeMark,
  DeepSeek: deepseekMark,
  'Moonshot AI': kimiMark
}

const MONOCHROME_MARKS: Record<string, string> = {
  OpenAI: openaiMark,
  OpenRouter: openrouterMark,
  Codex: openaiMark,
  xAI: grokMark
}

export function ProviderIcon({ company, size = 18 }: { company: string; size?: number }): JSX.Element {
  const colorArtwork = COLOR_MARKS[company]
  if (colorArtwork) {
    return <img src={colorArtwork} alt="" aria-hidden="true" width={size} height={size} className="shrink-0" />
  }
  const artwork = MONOCHROME_MARKS[company]
  if (artwork) {
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
