export type ServerUpdatePhase = 'idle' | 'downloading' | 'installing' | 'restarting'

export interface ServerUpdateState {
  currentVersion: string
  latestVersion: string | null
  available: boolean
  installable: boolean
  phase: ServerUpdatePhase
  progress: number | null
  error: string | null
  checkedAt: number | null
}

const VERSION_PATTERN = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/

export function parseVersion(value: string): string | null {
  const match = VERSION_PATTERN.exec(value.trim())
  return match ? match[0].replace(/^v/, '').replace(/\+.*$/, '') : null
}

function comparePrerelease(a: string | undefined, b: string | undefined): number {
  if (a === b) return 0
  if (a === undefined) return 1
  if (b === undefined) return -1
  const left = a.split('.')
  const right = b.split('.')
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const x = left[index]
    const y = right[index]
    if (x === undefined) return -1
    if (y === undefined) return 1
    const xNumeric = /^\d+$/.test(x)
    const yNumeric = /^\d+$/.test(y)
    if (xNumeric && yNumeric) {
      const difference = Number(x) - Number(y)
      if (difference !== 0) return Math.sign(difference)
    } else if (xNumeric !== yNumeric) {
      return xNumeric ? -1 : 1
    } else if (x !== y) {
      return x < y ? -1 : 1
    }
  }
  return 0
}

export function compareVersions(a: string, b: string): number {
  const left = VERSION_PATTERN.exec(a.trim())
  const right = VERSION_PATTERN.exec(b.trim())
  if (!left || !right) return 0
  for (let index = 1; index <= 3; index += 1) {
    const difference = Number(left[index]) - Number(right[index])
    if (difference !== 0) return Math.sign(difference)
  }
  return comparePrerelease(left[4], right[4])
}
