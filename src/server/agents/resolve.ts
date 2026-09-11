import { existsSync, readFileSync } from 'node:fs'
import { delimiter, extname, isAbsolute, join, resolve as resolvePath } from 'node:path'

export interface ResolvedCommand {
  command: string
  prefixArgs: string[]
  viaShell: boolean
}

const WINDOWS = process.platform === 'win32'

function pathExts(cmd: string): string[] {
  if (!WINDOWS) return ['']
  const raw = process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD'
  const list = raw.split(';').filter(Boolean).map((e) => e.toLowerCase())
  const lower = cmd.toLowerCase()
  return list.some((e) => lower.endsWith(e)) ? ['', ...list] : list
}

export function findOnPath(cmd: string): string | null {
  if (cmd.includes('/') || cmd.includes('\\') || isAbsolute(cmd)) {
    return existsSync(cmd) ? cmd : null
  }
  const dirs = (process.env.PATH ?? '').split(delimiter).filter(Boolean)
  for (const dir of dirs) {
    for (const ext of pathExts(cmd)) {
      const candidate = join(dir, cmd + ext)
      if (existsSync(candidate)) return candidate
    }
  }
  return null
}

function tokenize(line: string): string[] {
  const out: string[] = []
  let cur = ''
  let quoted = false
  for (const ch of line) {
    if (ch === '"') quoted = !quoted
    else if (!quoted && /\s/.test(ch)) {
      if (cur) out.push(cur)
      cur = ''
    } else cur += ch
  }
  if (cur) out.push(cur)
  return out
}

function unwrapShim(shimPath: string): ResolvedCommand | null {
  let contents: string
  try {
    contents = readFileSync(shimPath, 'utf8')
  } catch {
    return null
  }
  const dp0 = shimPath.slice(0, shimPath.lastIndexOf('\\') + 1)

  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line.includes('%*')) continue
    if (/^(@?echo|set|call|goto|exit|if not|endlocal|setlocal)\b/i.test(line)) continue

    const expanded = line
      .replace(/%~dp0/gi, dp0)
      .replace(/%dp0%/gi, dp0)
      .replace(/%\*/g, ' ')

    const tokens = tokenize(expanded).filter((t) => t && !t.startsWith('%'))
    if (!tokens.length) continue

    const start = tokens.findIndex((t) => !/^(if|exist|\(|\))$/i.test(t))
    if (start < 0) continue
    const [head, ...rest] = tokens.slice(start)

    const exe = isAbsolute(head) ? resolvePath(head) : findOnPath(head)
    if (!exe || !existsSync(exe)) continue

    const prefixArgs = rest
      .filter((t) => !/^[()]$/.test(t))
      .map((t) => (isAbsolute(t) ? resolvePath(t) : t))

    return { command: exe, prefixArgs, viaShell: false }
  }
  return null
}

export function resolveCommand(command: string): ResolvedCommand | null {
  const found = findOnPath(command)
  if (!found) return null

  if (WINDOWS && ['.cmd', '.bat'].includes(extname(found).toLowerCase())) {
    return unwrapShim(found) ?? { command: found, prefixArgs: [], viaShell: true }
  }
  return { command: found, prefixArgs: [], viaShell: false }
}
