import type { JSX, ReactNode } from 'react'
import { DEFAULT_FONT_SIZE, normalizeFontSize } from '@anvil/protocol/appearance'
import { IS_MAC } from '../keys'
import { useStore } from '../state/store'
import { cn } from '../ui'

const HAS_MAC_WINDOW_CONTROLS = IS_MAC && navigator.userAgent.includes('Electron/')
const ANVIL_ASCII = [
  '  ▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄',
  '▀▀█████████████████▀',
  '       ▀▀██████▀▀',
  '         ██████',
  '      ▄▄████████▄▄',
  '      ▀▀▀▀▀▀▀▀▀▀▀▀'
].join('\n')

export function WindowTitlebar({ children, className }: {
  children: ReactNode
  className?: string
}): JSX.Element {
  const fontSize = useStore((state) => state.settings?.fontSize)
  const scale = normalizeFontSize(fontSize) / DEFAULT_FONT_SIZE

  return (
    <header
      style={HAS_MAC_WINDOW_CONTROLS ? { height: 44 / scale } : undefined}
      className={cn('flex h-11 shrink-0 items-center', HAS_MAC_WINDOW_CONTROLS && 'drag-region', className)}
    >
      {HAS_MAC_WINDOW_CONTROLS && (
        <div aria-hidden="true" className="flex h-full shrink-0 items-center justify-center"
          style={{ width: 88 / scale }}>
          <div className="no-drag rounded-md border border-line bg-raised"
            style={{ width: 72 / scale, height: 28 / scale }} />
        </div>
      )}
      <div className="flex h-full min-w-0 flex-1 items-center px-4"
        style={HAS_MAC_WINDOW_CONTROLS ? { paddingLeft: 12 / scale, paddingRight: 16 / scale } : undefined}>
        {children}
      </div>
    </header>
  )
}

export function AnvilBrand(): JSX.Element {
  return (
    <span className="inline-flex shrink-0 items-center gap-2.5 font-mono text-xs font-semibold tracking-[0.14em] text-fg">
      <span aria-hidden="true" className="whitespace-pre font-mono text-[4px] leading-[4px] font-normal tracking-normal text-accent select-none">{ANVIL_ASCII}</span>
      <span>ANVIL</span>
    </span>
  )
}
