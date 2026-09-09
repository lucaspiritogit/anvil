import type { JSX } from 'react'
import { useMemo } from 'react'
import { field } from '../ui'

/**
 * The models a provider offers are printed as one flat identifier per line,
 * but they read as `provider/lab/model` (`openrouter/z-ai/glm-5`) or
 * `provider/model` (`opencode/gpt-5.4`). Everything before the last segment is
 * the heading the model sits under; the last segment is its name.
 */
function group(model: string): { heading: string; name: string } {
  const cut = model.lastIndexOf('/')
  return cut < 0
    ? { heading: '', name: model }
    : { heading: model.slice(0, cut), name: model.slice(cut + 1) }
}

function grouped(models: string[]): [string, string[]][] {
  const out = new Map<string, string[]>()
  for (const model of models) {
    const { heading } = group(model)
    const bucket = out.get(heading)
    if (bucket) bucket.push(model)
    else out.set(heading, [model])
  }
  return [...out]
}

/**
 * Picks one model out of a provider's catalogue. Knows nothing about which
 * agent produced the list — any array of identifiers renders the same way —
 * and falls back to a free-text field when the catalogue could not be read,
 * so an unreachable provider never blocks starting a task.
 */
export function ProviderModelSelect({
  models,
  value,
  onChange,
  loading = false,
  error,
  emptyLabel = 'Agent default'
}: {
  models: string[]
  value: string
  onChange: (model: string) => void
  loading?: boolean
  error?: string
  /** The "no explicit choice" option, which submits an empty model. */
  emptyLabel?: string
}): JSX.Element {
  const groups = useMemo(() => grouped(models), [models])

  if (!models.length && !loading) {
    return (
      <>
        <input
          className={field.sized}
          value={value}
          placeholder="provider/model (optional)"
          onChange={(e) => onChange(e.target.value)}
        />
        <span className={field.hint}>
          {error
            ? `Could not list models: ${error}. Type one instead.`
            : 'This agent takes no model.'}
        </span>
      </>
    )
  }

  // A model saved earlier can disappear from the catalogue. Keep it selectable
  // rather than silently switching the task to a different model.
  const missing = value && !models.includes(value) ? value : null

  return (
    <>
      <select
        className={field.sized}
        value={value}
        disabled={loading}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="">{loading ? 'Loading models…' : emptyLabel}</option>
        {missing && <option value={missing}>{missing} (not listed)</option>}
        {groups.map(([heading, items]) =>
          heading ? (
            <optgroup key={heading} label={heading}>
              {items.map((model) => (
                <option key={model} value={model}>
                  {group(model).name}
                </option>
              ))}
            </optgroup>
          ) : (
            items.map((model) => (
              <option key={model} value={model}>
                {model}
              </option>
            ))
          )
        )}
      </select>
      {error && <span className={field.hint}>{error}</span>}
    </>
  )
}
