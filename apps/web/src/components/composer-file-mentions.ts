import fuzzysort from 'fuzzysort'

export const FILE_MENTION_LIMIT = 30
export const fileReference = (path: string): string => `@${JSON.stringify(path)}`

export interface FileMention {
  start: number
  end: number
  query: string
}

// Quoted references use JSON escaping so spaces, Unicode, quotes and backslashes
// round-trip without making the text of the rest of the prompt ambiguous.
const mentions = /(^|[\s([{])@("(?:\\.|[^"\\])*"?|[^\s@"\])}]*)/g

export function activeFileMention(text: string, caret: number, end = caret): FileMention | null {
  if (caret !== end) return null
  for (const match of text.matchAll(mentions)) {
    const start = match.index + match[1].length
    const finish = match.index + match[0].length
    if (caret <= start || caret > finish) continue
    const token = match[2]
    if (token.startsWith('"') && token.endsWith('"') && token.length > 1 && caret === finish) return null
    const query = text.slice(start + 1, caret).replace(/^"/, '').replace(/\\(["\\])/g, '$1')
    return { start, end: finish, query }
  }
  return null
}

export function selectedFilePaths(text: string, selected: readonly string[]): string[] {
  const tokens = new Set([...text.matchAll(mentions)].map((match) => `@${match[2]}`))
  return selected.filter((path) => tokens.has(fileReference(path)))
}

export function rankFiles(paths: readonly string[], query: string): string[] {
  return fuzzysort.go(query, paths.map((path) => ({ path, name: path.split('/').at(-1)! })), {
    keys: ['name', 'path'], all: true, limit: FILE_MENTION_LIMIT,
    scoreFn: (result) => Math.max(result[0]?.score ?? 0, (result[1]?.score ?? 0) * 0.9)
  }).map((result) => result.obj.path)
}
