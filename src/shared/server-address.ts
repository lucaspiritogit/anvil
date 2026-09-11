export function serverAddress(value: string): string {
  const url = new URL(value)
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password ||
    url.pathname !== '/' || url.search || url.hash) throw new Error('Anvil server URL must be an HTTP base URL on 127.0.0.1')
  return url.origin
}
