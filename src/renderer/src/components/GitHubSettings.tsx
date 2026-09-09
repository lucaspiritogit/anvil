import type { JSX } from 'react'
import { useEffect, useState } from 'react'
import { btn, cn, field, modal } from '../ui'

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
    <section className={modal.section} aria-label="GitHub integration">
      <h3 className="my-3 text-[13px] font-semibold">GitHub</h3>
      <label className={field.wrap}>
        <span className={field.label}>Personal access token</span>
        <input
          className={field.sized}
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
        <span role="status" className="text-xs text-dim">{configured ? 'Token saved' : 'No token saved'}</span>
      </div>
      {error && <p role="alert" className="mt-2 text-xs text-danger">{error}</p>}
    </section>
  )
}
