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
    <div className="relative shrink-0">
      <label
        title={caffeineMode ? 'Caffeine mode is on: the computer and display stay awake while tasks are running' : 'Caffeine mode: keep the computer and display awake while tasks are running'}
        className={cn('relative grid size-8 cursor-pointer place-items-center border transition-colors duration-[120ms] motion-reduce:transition-none',
          caffeineMode ? 'border-ember-800 bg-ember-950 text-accent' : 'border-transparent text-faint hover:bg-hover hover:text-fg',
          'has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-accent has-[:disabled]:cursor-not-allowed')}
      >
        <input type="checkbox" aria-label="Caffeine mode" className="absolute inset-0 cursor-pointer opacity-0 disabled:cursor-not-allowed"
          checked={caffeineMode} disabled={!settings} onChange={(event) => void setCaffeineMode(event.target.checked)} />
        <Icon icon="coffee" size={16} aria-hidden="true" />
      </label>
      {failed && (
        <p role="alert" className="absolute right-0 bottom-full z-20 mb-2 w-56 border border-danger/40 bg-danger-tint px-3 py-2 text-[11px] text-danger-text shadow-[0_0_0_1px_var(--color-void)]">
          Could not save Caffeine mode. <button type="button" className="text-ember-400 hover:text-ember-300" onClick={() => void setCaffeineMode(caffeineSave.value)}>Retry</button>
        </p>
      )}
    </div>
  )
}
