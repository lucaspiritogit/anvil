import type { JSX } from 'react'
import { useEffect, useState } from 'react'
import { btn, cn, field } from '../ui'

export function GitHubSettings(): JSX.Element {
  const [configured, setConfigured] = useState(false)
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void window.anvil.github.credentialStatus().then(
      (status) => { if (!cancelled) setConfigured(status.configured) },
      (error: unknown) => { if (!cancelled) setError(error instanceof Error ? error.message : String(error)) }
    ).finally(() => { if (!cancelled) setBusy(false) })
    return () => { cancelled = true }
  }, [])

  const save = async (remove = false): Promise<void> => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const status = await (remove ? window.anvil.github.removeToken() : window.anvil.github.setToken(token))
      setConfigured(status.configured)
      setToken('')
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="mb-6 border border-line bg-raised" aria-label="GitHub integration">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-2.5">
        <h3 className="font-mono text-[11px] font-medium tracking-[0.12em] text-dim uppercase">GitHub</h3>
        <span className={cn('inline-flex h-5 items-center gap-1.5 px-2 font-mono text-[10px] tracking-[0.06em] uppercase', configured ? 'bg-ok-tint text-ok-text' : 'bg-overlay text-dim')}>
          <span aria-hidden="true">{configured ? '✓' : '○'}</span>
          <span role="status">{configured ? 'Token saved' : 'No token saved'}</span>
        </span>
      </div>
      <div className="px-4 py-3.5">
      <label className={field.wrap}>
        <span className={field.label}>Personal access token</span>
        <input
          className={cn(field.sized, 'font-mono text-xs')}
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={token}
          disabled={busy}
          placeholder={configured ? 'Token saved. Enter a new token to replace it.' : 'GitHub personal access token'}
          onChange={(event) => setToken(event.target.value)}
        />
        <small className={field.hint}>
          Give the token access to your repository and Pull requests write permission.
          PRs are opened as the token&apos;s GitHub account. The token is encrypted with your system keychain.
        </small>
      </label>
      <p className={cn(field.hint, 'mb-3')}>
        Git fetch and push use your existing Git authentication. Anvil does not change your Git username, email, or commit authors.
      </p>
      <div className="flex items-center gap-2">
        <button className={btn.ghost} disabled={busy || !token.trim()} onClick={() => void save()}>
          {busy ? 'Please wait…' : 'Save token'}
        </button>
        {configured && <button className={btn.ghost} disabled={busy} onClick={() => void save(true)}>Remove token</button>}
      </div>
      {error && <p role="alert" className="mt-2 text-xs text-danger">{error}</p>}
      </div>
    </section>
  )
}
