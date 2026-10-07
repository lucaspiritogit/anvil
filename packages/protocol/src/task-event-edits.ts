export interface TaskEventEdit {
  path: string
  additions: number
  deletions: number
  hunks: string
  omitted?: number
}

export type TaskEventEditLine =
  | { kind: 'hunk'; text: string }
  | { kind: 'context' | 'add' | 'delete'; text: string; oldLine?: number; newLine?: number }

type Change = { kind: ' ' | '-' | '+'; text: string }

const CONTEXT_LINES = 3
const MAX_HUNK_LINES = 400
const MAX_DIFF_CELLS = 1_000_000
const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/

function splitLines(text: string): string[] {
  if (!text) return []
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  if (lines.at(-1) === '') lines.pop()
  return lines
}

function diffLines(before: string[], after: string[]): Change[] {
  let start = 0
  while (start < before.length && start < after.length && before[start] === after[start]) start++
  let beforeEnd = before.length
  let afterEnd = after.length
  while (beforeEnd > start && afterEnd > start && before[beforeEnd - 1] === after[afterEnd - 1]) {
    beforeEnd--
    afterEnd--
  }
  const head = before.slice(0, start).map((text): Change => ({ kind: ' ', text }))
  const tail = before.slice(beforeEnd).map((text): Change => ({ kind: ' ', text }))
  const removed = before.slice(start, beforeEnd)
  const added = after.slice(start, afterEnd)
  if (removed.length * added.length > MAX_DIFF_CELLS) {
    return [...head, ...removed.map((text): Change => ({ kind: '-', text })), ...added.map((text): Change => ({ kind: '+', text })), ...tail]
  }
  const common = Array.from({ length: removed.length + 1 }, () => new Uint32Array(added.length + 1))
  for (let i = removed.length - 1; i >= 0; i--) {
    for (let j = added.length - 1; j >= 0; j--) {
      common[i][j] = removed[i] === added[j] ? common[i + 1][j + 1] + 1 : Math.max(common[i + 1][j], common[i][j + 1])
    }
  }
  const changes: Change[] = [...head]
  let i = 0
  let j = 0
  while (i < removed.length && j < added.length) {
    if (removed[i] === added[j]) {
      changes.push({ kind: ' ', text: removed[i] })
      i++
      j++
    } else if (common[i + 1][j] >= common[i][j + 1]) {
      changes.push({ kind: '-', text: removed[i++] })
    } else {
      changes.push({ kind: '+', text: added[j++] })
    }
  }
  while (i < removed.length) changes.push({ kind: '-', text: removed[i++] })
  while (j < added.length) changes.push({ kind: '+', text: added[j++] })
  return [...changes, ...tail]
}

function hunksFromChanges(changes: Change[], numbered: boolean): string[] {
  const positioned: (Change & { oldLine: number; newLine: number })[] = []
  let oldLine = 1
  let newLine = 1
  for (const change of changes) {
    positioned.push({ ...change, oldLine, newLine })
    if (change.kind !== '+') oldLine++
    if (change.kind !== '-') newLine++
  }
  const changed = positioned.flatMap((change, index) => change.kind === ' ' ? [] : [index])
  const lines: string[] = []
  for (let index = 0; index < changed.length; index++) {
    const start = Math.max(0, changed[index] - CONTEXT_LINES)
    let end = Math.min(positioned.length - 1, changed[index] + CONTEXT_LINES)
    while (index + 1 < changed.length && changed[index + 1] - CONTEXT_LINES <= end + 1) {
      index++
      end = Math.min(positioned.length - 1, changed[index] + CONTEXT_LINES)
    }
    const slice = positioned.slice(start, end + 1)
    if (numbered) {
      const oldCount = slice.filter((change) => change.kind !== '+').length
      const newCount = slice.filter((change) => change.kind !== '-').length
      lines.push(`@@ -${slice[0].oldLine},${oldCount} +${slice[0].newLine},${newCount} @@`)
    } else {
      lines.push('@@')
    }
    for (const change of slice) lines.push(`${change.kind}${change.text}`)
  }
  return lines
}

function capped(path: string, lines: string[]): TaskEventEdit {
  let additions = 0
  let deletions = 0
  for (const line of lines) {
    if (line.startsWith('+')) additions++
    else if (line.startsWith('-')) deletions++
  }
  const omitted = Math.max(0, lines.length - MAX_HUNK_LINES)
  return { path, additions, deletions, hunks: lines.slice(0, MAX_HUNK_LINES).join('\n'), ...(omitted ? { omitted } : {}) }
}

export function textEdit(path: string, before: string, after: string, numbered = true): TaskEventEdit {
  return capped(path, hunksFromChanges(diffLines(splitLines(before), splitLines(after)), numbered))
}

export function unifiedDiffEdit(path: string, diff: string): TaskEventEdit {
  const lines = splitLines(diff)
  const start = lines.findIndex((line) => line.startsWith('@@'))
  if (start < 0) return textEdit(path, '', diff)
  return capped(path, lines.slice(start).filter((line) => !line.startsWith('\\ No newline')))
}

export function structuredPatchEdit(path: string, hunks: { oldStart: number; oldLines: number; newStart: number; newLines: number; lines: string[] }[]): TaskEventEdit {
  return capped(path, hunks.flatMap((hunk) => [`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`, ...hunk.lines]))
}

export function taskEventEditLines(edit: TaskEventEdit): TaskEventEditLine[] {
  const lines: TaskEventEditLine[] = []
  let oldLine: number | undefined
  let newLine: number | undefined
  for (const line of splitLines(edit.hunks)) {
    if (line.startsWith('@@')) {
      const header = HUNK_HEADER.exec(line)
      oldLine = header ? Number(header[1]) : undefined
      newLine = header ? Number(header[2]) : undefined
      lines.push({ kind: 'hunk', text: line })
      continue
    }
    const kind = line.startsWith('+') ? 'add' : line.startsWith('-') ? 'delete' : 'context'
    lines.push({
      kind,
      text: line.slice(1),
      ...(kind !== 'add' && oldLine !== undefined ? { oldLine } : {}),
      ...(kind !== 'delete' && newLine !== undefined ? { newLine } : {})
    })
    if (kind !== 'add' && oldLine !== undefined) oldLine++
    if (kind !== 'delete' && newLine !== undefined) newLine++
  }
  return lines
}
