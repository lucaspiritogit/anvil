import type { JSX, ReactNode } from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { DITHER_KIT_URL } from '@shared/external-links'
import type { AnalyticsBreakdown, AnalyticsDailyPoint, TaskStatus, WorkspaceAnalytics } from '@shared/types'
import { AreaChart, LineChart } from '@dither-kit/area-chart'
import { Area, Line } from '@dither-kit/area'
import { BarChart } from '@dither-kit/bar-chart'
import { Bar } from '@dither-kit/bar'
import { BlockLegend } from '@dither-kit/block-legend'
import type { ChartConfig } from '@dither-kit/chart-context'
import { ActiveDot } from '@dither-kit/dot'
import { Grid } from '@dither-kit/grid'
import { Legend } from '@dither-kit/legend'
import type { DitherColor } from '@dither-kit/palette'
import { PieChart } from '@dither-kit/pie-chart'
import { Pie } from '@dither-kit/pie'
import { ReferenceLine } from '@dither-kit/reference-line'
import { Tooltip } from '@dither-kit/tooltip'
import { XAxis } from '@dither-kit/x-axis'
import { YAxis } from '@dither-kit/y-axis'
import { analyticsPresetPeriod, analyticsRange, moveAnalyticsPeriod, type AnalyticsPeriod, type AnalyticsPreset } from '../analytics-period'
import { formatCost, formatDurationMs, formatTokens } from '../format'
import { describeModel, humanizeModelName } from '../model-options'
import { useStore } from '../state/store'
import { cn } from '../ui'
import { AsciiMeter, ASCII_METER_TONE, asciiBar } from './AsciiMeter'
import { ProviderIcon } from './ProviderIcon'

const STATUS_CONFIG: Record<TaskStatus, { label: string; color: DitherColor }> = {
  pending: { label: 'Pending', color: 'orange' },
  running: { label: 'Running', color: 'blue' },
  succeeded: { label: 'Succeeded', color: 'green' },
  failed: { label: 'Failed', color: 'red' },
  cancelled: { label: 'Cancelled', color: 'purple' }
}

const TOKEN_CONFIG: ChartConfig = {
  totalTokens: { label: 'Tokens', color: 'blue' }
}

const TOKEN_MIX_CONFIG: ChartConfig = {
  inputTokens: { label: 'Input', color: 'blue' },
  cachedTokens: { label: 'Cached', color: 'green' },
  outputTokens: { label: 'Output', color: 'purple' }
}

const TASK_CONFIG: ChartConfig = {
  taskCount: { label: 'Tasks', color: 'orange' }
}

const CODE_CONFIG: ChartConfig = {
  additions: { label: 'Additions', color: 'green' },
  deletions: { label: 'Deletions', color: 'red' }
}

const PRESETS: { id: AnalyticsPreset; label: string }[] = [
  { id: '7d', label: '7d' },
  { id: '30d', label: '30d' },
  { id: 'this-month', label: 'This month' },
  { id: 'last-month', label: 'Last month' },
  { id: 'all', label: 'All' }
]

function count(value: number): string {
  return Math.round(value).toLocaleString('en')
}

function percent(value: number | null): string {
  return value === null ? 'n/a' : `${Math.round(value * 100)}%`
}

function fmtCompact(value: number): string {
  return new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(value)
}

function dayTick(value: unknown): string {
  return typeof value === 'string' ? value.slice(5).replace('-', '/') : ''
}

export function Panel({
  title,
  aside,
  children,
  className,
  bodyClassName
}: {
  title: string
  aside?: ReactNode
  children: ReactNode
  className?: string
  bodyClassName?: string
}): JSX.Element {
  const headingId = `analytics-${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`
  return (
    <section
      aria-labelledby={headingId}
      className={cn('corner-marks flex min-w-0 flex-col border border-line bg-card/90 backdrop-blur-[2px]', className)}
    >
      <header className="flex items-center gap-3 border-b border-dashed border-line px-4 py-2.5">
        <h2 id={headingId} className="shrink-0 text-[11px] font-medium tracking-[0.18em] text-muted-foreground uppercase">
          <span className="text-foreground/40">{'//'}</span> {title}
        </h2>
        <span
          aria-hidden="true"
          className="h-px min-w-0 flex-1 bg-[repeating-linear-gradient(to_right,var(--color-line)_0_2px,transparent_2px_5px)]"
        />
        {aside ? <div className="shrink-0 text-[11px] text-muted-foreground">{aside}</div> : null}
      </header>
      <div className={cn('flex min-w-0 flex-1 flex-col p-4', bodyClassName)}>{children}</div>
    </section>
  )
}

export function KpiCard({
  label,
  value,
  valueIcon,
  detail,
  index,
  className
}: {
  label: string
  value: string
  valueIcon?: ReactNode
  detail: string
  index: number
  className?: string
}): JSX.Element {
  return (
    <article
      className={cn(
        'corner-marks relative flex min-w-0 flex-col justify-between gap-4 overflow-hidden border border-line bg-card/90 p-4 transition-colors hover:border-foreground/40',
        className
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <p className="text-[11px] tracking-[0.18em] text-muted-foreground uppercase">{label}</p>
        <span className="text-[10px] text-muted-foreground/60 tabular-nums select-none">
          [{String(index).padStart(2, '0')}]
        </span>
      </div>
      <div className="relative">
        <div className="relative flex min-w-0 items-center gap-2.5">
          <p className="min-w-0 truncate text-[26px] leading-none font-semibold tracking-tight tabular-nums">{value}</p>
          {valueIcon}
        </div>
        <p className="relative mt-2 truncate text-[11px] text-muted-foreground">{detail}</p>
      </div>
    </article>
  )
}

function TokensOverTime({ daily }: { daily: AnalyticsDailyPoint[] }): JSX.Element {
  return (
    <div className="h-52 w-full">
      <AreaChart data={daily} config={TOKEN_CONFIG} bloom="low" margins={{ left: 46, right: 8, top: 12, bottom: 22 }}>
        <Grid strokeDasharray="1 4" />
        <XAxis dataKey="date" tickFormatter={dayTick} maxTicks={7} />
        <YAxis tickFormatter={fmtCompact} tickCount={4} />
        <Tooltip labelKey="date" valueFormatter={(value) => count(value)} />
        <Area dataKey="totalTokens" variant="dotted">
          <ActiveDot variant="filled" />
        </Area>
      </AreaChart>
    </div>
  )
}

export function TokenMixChart({ daily }: { daily: AnalyticsDailyPoint[] }): JSX.Element {
  return (
    <div className="flex h-52 w-full flex-col">
      <ul aria-label="Token colors" className="mb-2 flex justify-end gap-4 text-[11px] text-dim">
        {Object.entries(TOKEN_MIX_CONFIG).map(([key, entry]) => (
          <li key={key} className="flex items-center gap-1.5">
            <span className={cn('text-sm leading-none', ASCII_METER_TONE[entry.color])} aria-hidden="true">■</span>
            <span>{entry.label}</span>
          </li>
        ))}
      </ul>
      <div className="min-h-0 flex-1">
        <BarChart
          data={daily}
          config={TOKEN_MIX_CONFIG}
          stackType="stacked"
          bloom="low"
          margins={{ left: 46, right: 8, top: 6, bottom: 22 }}
        >
          <Grid strokeDasharray="1 4" />
          <XAxis dataKey="date" tickFormatter={dayTick} maxTicks={7} />
          <YAxis tickFormatter={fmtCompact} tickCount={4} />
          <Tooltip labelKey="date" valueFormatter={(value) => count(value)} />
          <Bar dataKey="cachedTokens" variant="dotted" isClickable />
          <Bar dataKey="inputTokens" variant="solid" isClickable />
          <Bar dataKey="outputTokens" variant="hatched" isClickable />
        </BarChart>
      </div>
    </div>
  )
}

export function OutcomesDonut({ counts }: { counts: Record<TaskStatus, number> }): JSX.Element | null {
  const data = useMemo(
    () => (Object.keys(STATUS_CONFIG) as TaskStatus[])
      .filter((status) => counts[status] > 0)
      .map((status) => ({ status, count: counts[status] })),
    [counts]
  )
  const config = useMemo(() => {
    const result: ChartConfig = {}
    for (const row of data) result[row.status] = STATUS_CONFIG[row.status]
    return result
  }, [data])

  if (data.length === 0) return null

  return (
    <div className="flex flex-col gap-2">
      <div className="h-40 w-full">
        <PieChart
          data={data}
          config={config}
          dataKey="count"
          nameKey="status"
          innerRadius={0.62}
          bloom="low"
          margins={{ top: 6, right: 6, bottom: 6, left: 6 }}
        >
          <Tooltip />
          <Pie variant="dotted" />
        </PieChart>
      </div>
      <BlockLegend
        config={config}
        values={Object.fromEntries(data.map((row) => [row.status, row.count]))}
        valueFormatter={count}
        align="center"
      />
    </div>
  )
}

function TasksPerDay({ daily }: { daily: AnalyticsDailyPoint[] }): JSX.Element {
  return (
    <div className="h-48 w-full">
      <BarChart data={daily} config={TASK_CONFIG} bloom="low" margins={{ left: 32, right: 8, top: 12, bottom: 22 }}>
        <Grid strokeDasharray="1 4" />
        <XAxis dataKey="date" tickFormatter={dayTick} maxTicks={6} />
        <YAxis tickFormatter={(value) => count(value)} tickCount={4} />
        <Tooltip labelKey="date" valueFormatter={(value) => count(value)} />
        <Bar dataKey="taskCount" variant="dotted" />
      </BarChart>
    </div>
  )
}

function CodeChangesChart({ daily }: { daily: AnalyticsDailyPoint[] }): JSX.Element {
  return (
    <div className="h-48 w-full">
      <LineChart data={daily} config={CODE_CONFIG} bloom="low" margins={{ left: 40, right: 8, top: 28, bottom: 22 }}>
        <Grid strokeDasharray="1 4" />
        <XAxis dataKey="date" tickFormatter={dayTick} maxTicks={6} />
        <YAxis tickFormatter={fmtCompact} tickCount={4} />
        <ReferenceLine y={0} />
        <Legend isClickable />
        <Tooltip labelKey="date" valueFormatter={(value) => count(value)} />
        <Line dataKey="additions" variant="dotted" isClickable>
          <ActiveDot variant="filled" />
        </Line>
        <Line dataKey="deletions" variant="hatched" strokeVariant="dashed" isClickable>
          <ActiveDot variant="filled" />
        </Line>
      </LineChart>
    </div>
  )
}

function rankingCompany(entry: Pick<AnalyticsBreakdown, 'key' | 'label'>, modelNames: boolean): string {
  if (modelNames) return describeModel(entry.key, '').company
  if (entry.key === 'codex') return 'OpenAI'
  if (entry.key === 'opencode') return 'OpenCode Zen'
  if (entry.key === 'claude') return 'Anthropic'
  return entry.label
}

function RankedList({ entries, empty, modelNames = false }: {
  entries: AnalyticsBreakdown[]
  empty: string
  modelNames?: boolean
}): JSX.Element {
  const maximum = entries[0]?.taskCount ?? 0
  if (entries.length === 0) return <p className="text-xs text-dim">{empty}</p>

  return (
    <ol className="space-y-3.5">
      {entries.slice(0, 5).map((entry, index) => (
        <li key={entry.key} className="grid min-w-0 gap-1">
          <div className="flex items-baseline gap-2 text-xs">
            <span className="w-5 shrink-0 text-dim">{String(index + 1).padStart(2, '0')}</span>
            <span className="min-w-0 truncate" title={entry.label}>
              {modelNames ? humanizeModelName(entry.label) : entry.label}
            </span>
            <ProviderIcon company={rankingCompany(entry, modelNames)} size={15} />
            <span className="min-w-0 flex-1" />
            <span className="shrink-0 text-[11px] text-dim tabular-nums">
              {count(entry.taskCount)}t · {formatTokens(entry.totalTokens)}
            </span>
          </div>
          <div className="flex items-center gap-2 pl-7 text-[10px] leading-none text-accent" aria-hidden="true">
            <span className="truncate tracking-[-0.05em]">{asciiBar(maximum ? entry.taskCount / maximum : 0, 22)}</span>
            <span className="text-dim">{percent(maximum ? entry.taskCount / maximum : 0)}</span>
          </div>
        </li>
      ))}
    </ol>
  )
}

function TokenTotals({ analytics }: { analytics: WorkspaceAnalytics }): JSX.Element {
  const total = analytics.tokens.total
  return (
    <div className="space-y-4">
      <AsciiMeter label="Input" value={formatTokens(analytics.tokens.input)} ratio={total ? analytics.tokens.input / total : 0} />
      <AsciiMeter label="Cached input" value={formatTokens(analytics.tokens.cached)} ratio={total ? analytics.tokens.cached / total : 0} tone="green" />
      <AsciiMeter label="Output" value={formatTokens(analytics.tokens.output)} ratio={total ? analytics.tokens.output / total : 0} tone="purple" />
    </div>
  )
}

function RangePicker({ period, onChange }: { period: AnalyticsPeriod; onChange: (period: AnalyticsPeriod) => void }): JSX.Element {
  const invalid = period.start > period.end
  const activePreset = PRESETS.find(({ id }) => {
    const value = analyticsPresetPeriod(id)
    return value.start === period.start && value.end === period.end
  })?.id

  return (
    <div aria-label="Analytics period" className="flex max-w-full flex-col items-end gap-2 max-[840px]:items-start">
      <div className="flex max-w-full flex-wrap items-end justify-end gap-1.5 max-[840px]:justify-start">
        <button
          type="button"
          aria-label="Previous period"
          disabled={invalid}
          onClick={() => onChange(moveAnalyticsPeriod(period, -1))}
          className="h-8 border border-line px-2.5 text-[11px] text-dim hover:border-fg/40 hover:text-fg disabled:opacity-40"
        >
          ← Prev
        </button>
        <label className="text-[10px] tracking-[0.12em] text-dim uppercase">
          Start date
          <input
            type="date"
            value={period.start}
            onChange={(event) => event.target.value && onChange({ ...period, start: event.target.value })}
            className="mt-1 block h-8 min-w-0 border border-line bg-canvas px-2 text-xs tracking-normal text-fg outline-none [color-scheme:dark] focus:border-accent"
          />
        </label>
        <span className="pb-2 text-dim">···</span>
        <label className="text-[10px] tracking-[0.12em] text-dim uppercase">
          End date
          <input
            type="date"
            value={period.end}
            onChange={(event) => event.target.value && onChange({ ...period, end: event.target.value })}
            className="mt-1 block h-8 min-w-0 border border-line bg-canvas px-2 text-xs tracking-normal text-fg outline-none [color-scheme:dark] focus:border-accent"
          />
        </label>
        <button
          type="button"
          aria-label="Next period"
          disabled={invalid}
          onClick={() => onChange(moveAnalyticsPeriod(period, 1))}
          className="h-8 border border-line px-2.5 text-[11px] text-dim hover:border-fg/40 hover:text-fg disabled:opacity-40"
        >
          Next →
        </button>
      </div>
      <div className="flex max-w-full flex-wrap justify-end gap-1 max-[840px]:justify-start">
        {PRESETS.map(({ id, label }) => (
          <button
            key={id}
            type="button"
            aria-pressed={activePreset === id}
            onClick={() => onChange(analyticsPresetPeriod(id))}
            className={cn(
              'h-6 border px-2 text-[10px] tracking-[0.08em] uppercase transition-colors',
              activePreset === id
                ? 'border-accent bg-accent text-canvas'
                : 'border-line bg-canvas/70 text-dim hover:border-fg/40 hover:text-fg'
            )}
          >
            {label}
          </button>
        ))}
      </div>
    </div>
  )
}

function AnalyticsContent({ analytics }: { analytics: WorkspaceAnalytics }): JSX.Element {
  const favoriteModel = analytics.favoriteModel
  const favoriteProvider = analytics.favoriteProvider
  const costValue = analytics.tasks.total > 0 && analytics.cost.reportedTaskCount === 0
    ? formatCost(null)
    : formatCost(analytics.cost.reportedUsd)
  const costDetail = analytics.cost.unreportedTaskCount > 0
    ? `${count(analytics.cost.reportedTaskCount)} of ${count(analytics.tasks.total)} tasks reported cost`
    : 'Reported by all tasks'

  if (analytics.tasks.total === 0) {
    return (
      <Panel title="No activity" aside="SQLite" bodyClassName="min-h-72 items-center justify-center text-center">
        <p className="text-sm text-fg">No tasks started during this period.</p>
        <p className="mt-2 max-w-md text-xs leading-relaxed text-dim">Choose another date range to explore workspace activity.</p>
      </Panel>
    )
  }

  return (
    <>
      {analytics.cost.unreportedTaskCount > 0 ? (
        <div role="note" className="corner-marks border border-warn/35 bg-warn/8 px-4 py-3 text-xs text-dim">
          USD totals include reported costs only. {count(analytics.cost.unreportedTaskCount)} {analytics.cost.unreportedTaskCount === 1 ? 'task has' : 'tasks have'} no cost data.
        </div>
      ) : null}
      <dl aria-label="Analytics summary" className="grid grid-cols-5 gap-3 max-[1180px]:grid-cols-3 max-[760px]:grid-cols-2 max-[440px]:grid-cols-1">
        <KpiCard index={1} label="Tokens used" value={formatTokens(analytics.tokens.total)} detail={`${count(analytics.tokens.total)} total tokens`} />
        <KpiCard index={2} label="Reported USD" value={costValue} detail={costDetail} />
        <KpiCard index={3} label="Favorite model" value={favoriteModel ? humanizeModelName(favoriteModel.label) : '—'} detail={favoriteModel ? `${count(favoriteModel.taskCount)} tasks` : 'No model activity'} />
        <KpiCard
          index={4}
          label="Favorite provider"
          value={favoriteProvider?.label ?? '—'}
          valueIcon={favoriteProvider ? <ProviderIcon company={rankingCompany(favoriteProvider, false)} size={25} /> : undefined}
          detail={favoriteProvider ? `${count(favoriteProvider.taskCount)} tasks` : 'No provider activity'}
        />
        <KpiCard index={5} label="Completed tasks" value={count(analytics.tasks.completed)} detail={`${count(analytics.tasks.total)} total · ${percent(analytics.tasks.successRate)} success`} className="max-[1180px]:col-span-2 max-[760px]:col-span-1" />
      </dl>

      <div className="grid grid-cols-12 gap-3 max-[940px]:grid-cols-1">
        <Panel title="Tokens over time" aside={`${analytics.daily.length} active days`} className="col-span-8 max-[940px]:col-span-1" bodyClassName="pb-3">
          <TokensOverTime daily={analytics.daily} />
        </Panel>
        <Panel title="Token totals" aside={formatTokens(analytics.tokens.total)} className="col-span-4 max-[940px]:col-span-1" bodyClassName="justify-center">
          <TokenTotals analytics={analytics} />
        </Panel>

        <Panel title="Token mix per day" aside="stacked" className="col-span-8 max-[940px]:col-span-1" bodyClassName="pb-3">
          <TokenMixChart daily={analytics.daily} />
        </Panel>
        <Panel title="Task outcomes" aside={percent(analytics.tasks.successRate)} className="col-span-4 max-[940px]:col-span-1">
          <AsciiMeter
            label="Success rate"
            value={`${count(analytics.tasks.successful)} / ${count(analytics.tasks.completed)}`}
            ratio={analytics.tasks.successRate ?? 0}
            tone="green"
            width={18}
            className="mb-2"
          />
          <OutcomesDonut counts={analytics.tasks.statusCounts} />
        </Panel>

        <Panel title="Tasks per day" aside={`${count(analytics.tasks.total)} total`} className="col-span-6 max-[940px]:col-span-1" bodyClassName="pb-3">
          <TasksPerDay daily={analytics.daily} />
          <div className="mt-2 grid grid-cols-2 gap-4 border-t border-dashed border-line pt-3 text-xs">
            <div><span className="text-dim">Avg tokens/task</span><strong className="mt-1 block font-medium">{formatTokens(analytics.tokens.total / analytics.tasks.total)}</strong></div>
            <div><span className="text-dim">Avg working time</span><strong className="mt-1 block font-medium">{formatDurationMs(analytics.timing.averageWorkingTimeMs)}</strong></div>
          </div>
        </Panel>
        <Panel title="Additions vs deletions" aside={`${count(analytics.codeChanges.filesChanged)} files`} className="col-span-6 max-[940px]:col-span-1" bodyClassName="pb-3">
          <CodeChangesChart daily={analytics.daily} />
          <div className="mt-2 flex gap-5 border-t border-dashed border-line pt-3 text-xs">
            <span className="text-ok">+{count(analytics.codeChanges.additions)} additions</span>
            <span className="text-danger">−{count(analytics.codeChanges.deletions)} deletions</span>
            <span className="ml-auto text-dim">{formatDurationMs(analytics.timing.workingTimeMs)} worked</span>
          </div>
        </Panel>

        <Panel title="Top models" className="col-span-4 max-[940px]:col-span-1">
          <RankedList entries={analytics.breakdowns.models} empty="No model activity." modelNames />
        </Panel>
        <Panel title="Top providers" className="col-span-4 max-[940px]:col-span-1">
          <RankedList entries={analytics.breakdowns.providers} empty="No provider activity." />
        </Panel>
        <Panel title="Top projects" className="col-span-4 max-[940px]:col-span-1">
          <RankedList entries={analytics.breakdowns.projects} empty="No project activity." />
        </Panel>
      </div>
    </>
  )
}

export function AnalyticsPage(): JSX.Element {
  const workspaceId = useStore((state) => state.activeWorkspaceId)
  const [period, setPeriod] = useState<AnalyticsPeriod>(() => analyticsPresetPeriod('30d'))
  const [analytics, setAnalytics] = useState<WorkspaceAnalytics | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [retry, setRetry] = useState(0)
  const requestId = useRef(0)
  const invalidRange = period.start > period.end

  useEffect(() => {
    const currentRequest = ++requestId.current
    if (!workspaceId || invalidRange) {
      setAnalytics(null)
      setError(null)
      setLoading(false)
      return
    }
    setAnalytics(null)
    setError(null)
    setLoading(true)
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
  }, [invalidRange, period, retry, workspaceId])

  return (
    <div className="analytics-grid h-full overflow-y-auto px-8 py-7 font-mono max-[900px]:px-5 max-[700px]:px-3 max-[700px]:py-3">
      <div className="mx-auto flex w-full max-w-[1440px] flex-col gap-4">
        <header className="flex items-start justify-between gap-8 border-b border-dashed border-line pb-4 max-[840px]:flex-col max-[840px]:gap-4">
          <div className="min-w-0">
            <p className="mb-2 text-[10px] tracking-[0.2em] text-accent uppercase">Workspace telemetry / SQLite</p>
            <h1 className="text-xl font-semibold tracking-[-0.03em]">Analytics</h1>
            <p className="mt-1 text-xs text-dim">Task usage and outcomes for the selected period.</p>
            <a
              href={DITHER_KIT_URL}
              target="_blank"
              rel="noreferrer"
              className="mt-2 inline-flex items-center gap-1.5 border-b border-dotted border-accent/50 pb-0.5 text-[10px] tracking-[0.12em] text-dim uppercase transition-colors hover:border-accent hover:text-accent focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-2 focus-visible:outline-accent"
            >
              <span aria-hidden="true" className="text-accent">◆</span>
              Charts by Dither Kit
              <span aria-hidden="true">↗</span>
            </a>
          </div>
          <RangePicker period={period} onChange={setPeriod} />
        </header>

        {invalidRange ? (
          <div role="alert" className="corner-marks border border-danger/50 bg-danger/8 px-4 py-5 text-sm text-danger">
            Start date must not be after end date. Adjust either date or choose a preset.
          </div>
        ) : loading ? (
          <div role="status" className="corner-marks grid min-h-64 place-items-center border border-line bg-raised/90 text-sm text-dim">
            Reading analytics from SQLite…
          </div>
        ) : error ? (
          <div role="alert" className="corner-marks border border-danger/40 bg-danger/8 p-4 text-sm">
            <p>Analytics could not be loaded. {error}</p>
            <button type="button" className="mt-3 border border-line px-3 py-1.5 text-xs text-accent hover:bg-hover focus-visible:outline focus-visible:outline-accent" onClick={() => setRetry((value) => value + 1)}>Retry</button>
          </div>
        ) : analytics ? <AnalyticsContent analytics={analytics} /> : null}
      </div>
    </div>
  )
}
