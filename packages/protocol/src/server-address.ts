export function serverAddress(value: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error('Anvil server URL must be a valid HTTP or HTTPS URL.')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Anvil server URL must use HTTP or HTTPS.')
  }
  if (url.username || url.password) throw new Error('Anvil server URL cannot include credentials.')
  const suffix = url.href.slice(url.origin.length)
  if (suffix.includes('?')) throw new Error('Anvil server URL cannot include a query string.')
  if (suffix.includes('#')) throw new Error('Anvil server URL cannot include a fragment.')
  if (url.pathname !== '/') throw new Error('Anvil server URL cannot include a path.')
  return url.origin
}

export type ServerTarget =
  | { mode: 'local' }
  | { mode: 'remote'; url: string }

export function normalizeServerTarget(value: unknown): ServerTarget {
  if (!value || typeof value !== 'object' || !('mode' in value)) {
    throw new Error('Anvil server target must select the local or remote server mode.')
  }
  if (value.mode === 'local') return { mode: 'local' }
  if (value.mode === 'remote' && 'url' in value && typeof value.url === 'string') {
    return { mode: 'remote', url: serverAddress(value.url) }
  }
  throw new Error('A remote Anvil server target must include its HTTP or HTTPS base URL.')
}
