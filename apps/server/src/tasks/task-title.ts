export function titleFor(prompt: string): string {
  const line = prompt.trim().split('\n')[0].trim()
  return line.length > 72 ? `${line.slice(0, 71)}...` : line || 'Untitled task'
}
