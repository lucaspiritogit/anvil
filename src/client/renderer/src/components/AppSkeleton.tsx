import type { JSX } from 'react'

/*
 * The placeholder shell painted before main reports readiness. Its shape mirrors
 * the real 304px sidebar plus canvas so the first paint does not jump when the
 * live workspace replaces it. Decorative bars are hidden from assistive tech;
 * the container announces the wait once through role="status".
 */
const BAR = 'animate-pulse bg-hover motion-reduce:animate-none'

export function AppSkeleton(): JSX.Element {
  return (
    <div role="status" aria-label="Loading Anvil" className="grid h-full min-h-0 grid-cols-[304px_1fr] overflow-hidden bg-canvas">
      <div aria-hidden="true" className="flex min-h-0 flex-col border-r border-line">
        <div className="flex h-11 shrink-0 items-center px-4">
          <div className={`h-3 w-16 ${BAR}`} />
        </div>
        <div className="flex shrink-0 flex-col gap-2 px-2.5 pb-3">
          <div className={`h-9 border border-line ${BAR}`} />
          <div className={`h-7 ${BAR}`} />
        </div>
        <div className="flex min-h-0 flex-1 flex-col gap-2 px-2.5 pt-1">
          {Array.from({ length: 7 }, (_, index) => <div key={index} className={`h-11 ${BAR}`} />)}
        </div>
      </div>
      <div aria-hidden="true" className="flex min-w-0 min-h-0 flex-col">
        <div className="flex h-11 shrink-0 items-center border-b border-line px-4">
          <div className={`h-3 w-40 ${BAR}`} />
        </div>
        <div className="flex min-h-0 flex-1 flex-col gap-4 p-8">
          <div className={`h-5 w-1/3 ${BAR}`} />
          <div className={`h-24 border border-line ${BAR}`} />
          <div className={`h-5 w-2/3 ${BAR}`} />
          <div className={`h-5 w-1/2 ${BAR}`} />
        </div>
      </div>
    </div>
  )
}
