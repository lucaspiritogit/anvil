import type { JSX } from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { AnalyticsBreakdown, TaskStatus, WorkspaceAnalytics } from '@shared/types'
import { analyticsRange, currentMonthPeriod, moveAnalyticsPeriod, type AnalyticsPeriod } from '../analytics-period'
import { formatCost, formatDurationMs, formatTokens } from '../format'
import { humanizeModelName } from '../model-options'
import { useStore } from '../state/store'
import { cn } from '../ui'

const STATUS_LABELS: Record<TaskStatus, string> = {
  pending: 'Pending',
  running: 'Running',
  succeeded: 'Succeeded',
  failed: 'Failed',
  cancelled: 'Cancelled'
}

const STATUS_COLORS: Record<TaskStatus, string> = {
  pending: 'bg-warn',
  running: 'bg-accent',
  succeeded: 'bg-ok',
  failed: 'bg-danger',
  cancelled: 'bg-violet'
}

function count(value: number): string {
  return value.toLocaleString('en')
}

function percent(value: number | null): string {
  return value === null ? 'n/a' : `${Math.round(value * 100)}%`
}

function PrimaryCard({ label, value, detail, title }: {
  label: string
  value: string
  detail: string
  title?: string
}): JSX.Element {
  return (
    <div className="min-w-0 border border-line bg-raised p-4">
      <dt className="text-[11px] font-medium uppercase tracking-[0.1em] text-dim">{label}</dt>
      <dd className="mt-2 min-w-0 truncate text-xl font-semibold text-fg" title={title}>{value}</dd>
      <p className="mt-1 truncate text-[11px] text-dim" title={detail}>{detail}</p>
    </div>
  )
}

function Panel({ title, children, className }: { title: string; children: React.ReactNode; className?: string }): JSX.Element {
  return (
    <section aria-labelledby={`analytics-${title.toLowerCase().replace(/[^a-z]+/g, '-')}`} className={cn('min-w-0 border border-line bg-raised p-4', className)}>
      <h2 id={`analytics-${title.toLowerCase().replace(/[^a-z]+/g, '-')}`} className="mb-4 text-xs font-semibold uppercase tracking-[0.1em] text-dim">{title}</h2>
      {children}
    </section>
  )
}

function MeterRow({ label, value, total, color = 'bg-accent' }: {
  label: string
  value: number
  total: number
  color?: string
}): JSX.Element {
  const width = total ? Math.min(100, value / total * 100) : 0
  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between gap-3 text-xs">
        <span className="text-dim">{label}</span>
        <span className="font-mono text-fg">{formatTokens(value)}</span>
      </div>
      <div className="h-1.5 overflow-hidden bg-line" aria-hidden="true">
        <div className={cn('h-full', color)} style={{ width: `${width}%` }} />
      </div>
    </div>
  )
}

function RankedList({ entries, empty, modelNames = false }: {
  entries: AnalyticsBreakdown[]
  empty: string
  modelNames?: boolean
}): JSX.Element {
  const maximum = entries[0]?.taskCount ?? 0
  if (!entries.length) return <p className="text-xs text-dim">{empty}</p>
  return (
    <ol className="space-y-3">
      {entries.slice(0, 5).map((entry) => (
        <li key={entry.key} className="relative min-w-0 overflow-hidden px-2 py-1.5">
          <span className="absolute inset-y-0 left-0 bg-accent/8" style={{ width: `${maximum ? entry.taskCount / maximum * 100 : 0}%` }} aria-hidden="true" />
          <span className="relative flex min-w-0 items-baseline justify-between gap-3 text-xs">
            <span className="truncate text-fg" title={entry.label}>{modelNames ? humanizeModelName(entry.label) : entry.label}</span>
            <span className="shrink-0 text-dim">{count(entry.taskCount)} {entry.taskCount === 1 ? 'task' : 'tasks'} · {formatTokens(entry.totalTokens)}</span>
          </span>
        </li>
      ))}
    </ol>
  )
}

function AnalyticsContent({ analytics }: { analytics: WorkspaceAnalytics }): JSX.Element {
  const { tasks, tokens, cost, favoriteModel, favoriteProvider, timing, codeChanges, breakdowns } = analytics
  const costValue = tasks.total > 0 && cost.reportedTaskCount === 0 ? formatCost(null) : formatCost(cost.reportedUsd)
  const costDetail = tasks.total === 0
    ? 'No tasks in this period'
    : cost.unreportedTaskCount
      ? `${count(cost.reportedTaskCount)} of ${count(tasks.total)} tasks reported cost`
      : 'Reported by all tasks'
  const modelDetail = favoriteModel ? `${count(favoriteModel.taskCount)} ${favoriteModel.taskCount === 1 ? 'task' : 'tasks'}` : tasks.total ? 'No model data reported' : 'No tasks in this period'
  const averageTokens = tasks.total ? tokens.total / tasks.total : 0
  return (
    <>
      {tasks.total === 0 && (
        <div role="status" className="border border-line bg-raised px-4 py-3 text-sm text-dim">
          No tasks started during this period. Choose another date range to explore workspace activity.
        </div>
      )}
      {cost.unreportedTaskCount > 0 && (
        <div role="note" className="border border-warn/35 bg-warn/8 px-4 py-3 text-xs text-dim">
          USD totals include only reported costs. {count(cost.unreportedTaskCount)} {cost.unreportedTaskCount === 1 ? 'task has' : 'tasks have'} no cost data.
        </div>
      )}
      <dl aria-label="Analytics summary" className="grid grid-cols-5 gap-3 max-[1100px]:grid-cols-3 max-[760px]:grid-cols-2 max-[440px]:grid-cols-1">
        <PrimaryCard label="Tokens used" value={formatTokens(tokens.total)} detail={`${count(tokens.total)} total tokens`} />
        <PrimaryCard label="Reported USD used" value={costValue} detail={costDetail} />
        <PrimaryCard label="Favorite model" value={favoriteModel ? humanizeModelName(favoriteModel.label) : '—'} detail={modelDetail} title={favoriteModel?.label} />
        <PrimaryCard label="Favorite provider" value={favoriteProvider?.label ?? '—'} detail={favoriteProvider ? `${count(favoriteProvider.taskCount)} ${favoriteProvider.taskCount === 1 ? 'task' : 'tasks'}` : 'No provider data'} title={favoriteProvider?.label} />
        <PrimaryCard label="Completed tasks" value={count(tasks.completed)} detail={`${count(tasks.total)} total · ${percent(tasks.successRate)} success`} />
      </dl>
      <div className="grid grid-cols-12 gap-3 max-[920px]:grid-cols-2 max-[620px]:grid-cols-1">
        <Panel title="Token mix" className="col-span-4 max-[920px]:col-span-1">
          <div className="space-y-3">
            <MeterRow label="Input" value={tokens.input} total={tokens.total} />
            <MeterRow label="Output" value={tokens.output} total={tokens.total} color="bg-violet" />
            <MeterRow label="Cached input" value={tokens.cached} total={tokens.total} color="bg-cyan" />
          </div>
        </Panel>
        <Panel title="Task outcomes" className="col-span-4 max-[920px]:col-span-1">
          <div className="mb-4 flex items-end justify-between gap-3">
            <span className="text-xs text-dim">Success rate</span>
            <strong className="text-xl font-semibold">{percent(tasks.successRate)}</strong>
          </div>
          <ul className="grid grid-cols-2 gap-x-4 gap-y-2">
            {(Object.keys(STATUS_LABELS) as TaskStatus[]).map((status) => (
              <li key={status} className="flex items-center justify-between gap-2 text-xs">
                <span className="flex items-center gap-2 text-dim"><span className={cn('size-1.5 rounded-full', STATUS_COLORS[status])} aria-hidden="true" />{STATUS_LABELS[status]}</span>
                <span className="font-mono">{count(tasks.statusCounts[status])}</span>
              </li>
            ))}
          </ul>
        </Panel>
        <Panel title="Per task averages" className="col-span-4 max-[920px]:col-span-2 max-[620px]:col-span-1">
          <dl className="grid grid-cols-2 gap-x-4 gap-y-4">
            <div><dt className="text-xs text-dim">Tokens</dt><dd className="mt-1 text-lg font-semibold">{formatTokens(averageTokens)}</dd></div>
            <div><dt className="text-xs text-dim">Working time</dt><dd className="mt-1 text-lg font-semibold">{formatDurationMs(timing.averageWorkingTimeMs)}</dd></div>
            <div className="col-span-2 border-t border-line pt-3"><dt className="text-xs text-dim">Total working time</dt><dd className="mt-1 font-mono text-sm">{formatDurationMs(timing.workingTimeMs)}</dd></div>
          </dl>
        </Panel>
        <Panel title="Top models" className="col-span-4 max-[920px]:col-span-1">
          <RankedList entries={breakdowns.models} empty="No model data reported." modelNames />
        </Panel>
        <Panel title="Top providers" className="col-span-4 max-[920px]:col-span-1">
          <RankedList entries={breakdowns.providers} empty="No provider activity." />
        </Panel>
        <Panel title="Top projects" className="col-span-4 max-[920px]:col-span-2 max-[620px]:col-span-1">
          <RankedList entries={breakdowns.projects} empty="No project activity." />
        </Panel>
        <Panel title="Code changes" className="col-span-12 max-[920px]:col-span-2 max-[620px]:col-span-1">
          <dl className="grid grid-cols-3 divide-x divide-line text-center">
            <div><dt className="text-xs text-dim">Files changed</dt><dd className="mt-1 text-lg font-semibold">{count(codeChanges.filesChanged)}</dd></div>
            <div><dt className="text-xs text-dim">Additions</dt><dd className="mt-1 text-lg font-semibold text-ok">+{count(codeChanges.additions)}</dd></div>
            <div><dt className="text-xs text-dim">Deletions</dt><dd className="mt-1 text-lg font-semibold text-danger">−{count(codeChanges.deletions)}</dd></div>
          </dl>
        </Panel>
      </div>
    </>
  )
}

export function AnalyticsPage(): JSX.Element {
  const workspaceId = useStore((state) => state.activeWorkspaceId)
  const [period, setPeriod] = useState<AnalyticsPeriod>(() => currentMonthPeriod())
  const [analytics, setAnalytics] = useState<WorkspaceAnalytics | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [retry, setRetry] = useState(0)
  const requestId = useRef(0)
  const thisMonth = useMemo(() => currentMonthPeriod(), [])

  useEffect(() => {
    if (!workspaceId) return
    const currentRequest = ++requestId.current
    setLoading(true)
    setError(null)
    setAnalytics(null)
    void window.anvil.analytics.get(analyticsRange(period)).then((result) => {
      if (requestId.current !== currentRequest) return
      setAnalytics(result)
      setLoading(false)
    }).catch((reason: unknown) => {
      if (requestId.current !== currentRequest) return
      setError(reason instanceof Error ? reason.message : 'Analytics could not be loaded')
      setLoading(false)
    })
    return () => { requestId.current += 1 }
  }, [period, retry, workspaceId])

  const setStart = (start: string): void => {
    if (!start) return
    setPeriod((current) => ({ start, end: start > current.end ? start : current.end }))
  }
  const setEnd = (end: string): void => {
    if (!end) return
    setPeriod((current) => ({ start: end < current.start ? end : current.start, end }))
  }

  return (
    <div className="h-full overflow-y-auto bg-canvas px-8 py-7 max-[900px]:px-5 max-[700px]:px-3 max-[700px]:py-3">
      <div className="mx-auto flex w-full max-w-[1280px] flex-col gap-4">
        <header className="flex items-start justify-between gap-6 max-[760px]:flex-col max-[760px]:gap-4">
          <div>
            <h1 className="text-xl font-semibold">Analytics</h1>
            <p className="mt-1 text-xs text-dim">Workspace task usage and outcomes for the selected period.</p>
          </div>
          <div aria-label="Analytics period" className="flex max-w-full flex-wrap items-end justify-end gap-2 max-[760px]:w-full max-[760px]:justify-start">
            <button type="button" aria-label="Previous period" title="Previous period" onClick={() => setPeriod((value) => moveAnalyticsPeriod(value, -1))}
              className="h-8 border border-line px-2.5 text-sm text-dim hover:bg-hover hover:text-fg focus-visible:outline focus-visible:outline-accent">←</button>
            <label className="text-[11px] text-dim">Start date
              <input type="date" value={period.start} max={period.end} onChange={(event) => setStart(event.target.value)}
                className="mt-1 block h-8 min-w-0 bg-canvas px-2 text-xs text-fg [color-scheme:dark] border border-line outline-none focus:border-accent" />
            </label>
            <label className="text-[11px] text-dim">End date
              <input type="date" value={period.end} min={period.start} onChange={(event) => setEnd(event.target.value)}
                className="mt-1 block h-8 min-w-0 bg-canvas px-2 text-xs text-fg [color-scheme:dark] border border-line outline-none focus:border-accent" />
            </label>
            <button type="button" aria-label="Next period" title="Next period" onClick={() => setPeriod((value) => moveAnalyticsPeriod(value, 1))}
              className="h-8 border border-line px-2.5 text-sm text-dim hover:bg-hover hover:text-fg focus-visible:outline focus-visible:outline-accent">→</button>
            <button type="button" onClick={() => setPeriod(currentMonthPeriod())} disabled={period.start === thisMonth.start && period.end === thisMonth.end}
              className="h-8 border border-line px-3 text-xs text-dim hover:bg-hover hover:text-fg disabled:cursor-default disabled:opacity-45 focus-visible:outline focus-visible:outline-accent">This month</button>
          </div>
        </header>
        {loading && <div role="status" className="grid min-h-64 place-items-center border border-line bg-raised text-sm text-dim">Loading analytics…</div>}
        {!loading && error && (
          <div role="alert" className="border border-danger/40 bg-danger/8 p-4 text-sm">
            <p>Analytics could not be loaded. {error}</p>
            <button type="button" className="mt-3 border border-line px-3 py-1.5 text-xs text-accent hover:bg-hover focus-visible:outline focus-visible:outline-accent" onClick={() => setRetry((value) => value + 1)}>Retry</button>
          </div>
        )}
        {!loading && analytics && <AnalyticsContent analytics={analytics} />}
      </div>
    </div>
  )
}
