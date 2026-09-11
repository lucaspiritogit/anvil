import type { JSX } from 'react'
import { Icon } from '../icons'
import { cn } from '../ui'
import { useStore } from '../state/store'

export function CaffeineToggle(): JSX.Element {
  const settings = useStore((state) => state.settings)
  const caffeineSave = useStore((state) => state.caffeineSave)
  const setCaffeineMode = useStore((state) => state.setCaffeineMode)
  const caffeineMode = caffeineSave?.status === 'pending' ? caffeineSave.value : settings?.caffeineMode ?? false
  const failed = caffeineSave?.status === 'error'
  return (
    <div className="mx-2.5 mb-1 shrink-0 border border-line">
      <label className="flex items-center gap-2.5 px-3 py-2 text-xs text-dim">
        <Icon icon="coffee" size={18} aria-hidden="true" />
        <span className={cn('flex-1', caffeineMode && 'text-fg')}>Caffeine mode</span>
        <span className={cn('relative inline-flex h-4 w-7 shrink-0 items-center rounded-full border transition-colors duration-150 motion-reduce:transition-none',
          caffeineMode ? 'border-accent bg-accent' : 'border-line bg-canvas',
          'has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-accent')}>
          <input type="checkbox" aria-label="Caffeine mode" className="absolute inset-0 cursor-pointer opacity-0 disabled:cursor-not-allowed"
            checked={caffeineMode} disabled={!settings} onChange={(event) => void setCaffeineMode(event.target.checked)} />
          <span className={cn('pointer-events-none ml-[2px] size-3 rounded-full transition-[transform,background-color] duration-150 motion-reduce:transition-none', caffeineMode ? 'translate-x-2.5 bg-canvas' : 'bg-dim')} />
        </span>
      </label>
      <p className="px-3 pb-2 text-[11px] leading-[1.4] text-dim">Keep the computer and display awake while tasks are running</p>
      {failed && (
        <p role="alert" className="px-3 pb-2 text-[11px] text-danger">
          Could not save Caffeine mode. <button type="button" className="text-accent" onClick={() => void setCaffeineMode(caffeineSave.value)}>Retry</button>
        </p>
      )}
    </div>
  )
}
