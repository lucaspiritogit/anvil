/** Keep these desktop defaults aligned with .env.example. */
export const DEFAULT_OLLAMA_BASE_URL = 'http://localhost:11434/v1'
export const DEFAULT_EMBEDDING_MODEL = 'mxbai-embed-large'

export function isOllamaBaseUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 2048 || value.trim() !== value) return false
  try {
    const url = new URL(value)
    return (url.protocol === 'http:' || url.protocol === 'https:') && !url.username && !url.password && !url.search && !url.hash
  } catch {
    return false
  }
}
