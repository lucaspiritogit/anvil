import type { JSX } from 'react'
import { useMemo } from 'react'
import type { Task } from '@shared/types'
import { formatCost, formatTokens } from '../format'

function UsageStat({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] text-dim">{label}</dt>
      <dd className="mt-1 break-words text-xl font-semibold leading-none tracking-tight tabular-nums text-fg">
        {value}
      </dd>
    </div>
  )
}

// Retained for reuse; the project overview currently shows only the composer.
export function MonthlyUsage({ tasks }: { tasks: Task[] }): JSX.Element {
  const monthUsage = useMemo(() => {
    const date = new Date()
    const monthStart = new Date(date.getFullYear(), date.getMonth(), 1).getTime()
    const current = tasks.filter((task) => task.startedAt >= monthStart)
    return {
      tokens: current.reduce((total, task) => total + task.totalTokens, 0),
      cost: current.reduce((total, task) => total + (task.costUsd ?? 0), 0),
      unreportedCosts: current.filter((task) => task.costUsd === null).length
    }
  }, [tasks])

  return (
    <section aria-labelledby="monthly-usage-title" className="mt-6 flex flex-wrap items-start justify-between gap-x-10 gap-y-3 border-t border-line pt-4">
      <div className="min-w-0">
        <h2 id="monthly-usage-title" className="text-[11px] uppercase tracking-[0.08em] text-dim">Usage this month</h2>
        {monthUsage.unreportedCosts > 0 && (
          <p className="mt-1 text-[11px] text-dim/70">
            {monthUsage.unreportedCosts} task{monthUsage.unreportedCosts === 1 ? '' : 's'} without a reported cost
          </p>
        )}
      </div>
      <dl className="flex gap-10">
        <UsageStat label="Tokens used" value={formatTokens(monthUsage.tokens)} />
        <UsageStat label="Cost in USD" value={formatCost(monthUsage.cost)} />
      </dl>
    </section>
  )
}
