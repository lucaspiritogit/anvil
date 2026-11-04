export type RiskKind = 'secrets' | 'migration' | 'ci' | 'lockfile' | 'deletion' | 'unexpected'

export interface RiskFlag {
  kind: RiskKind
  label: string
  files: string[]
}

export interface PatchFileStat {
  path: string
  additions: number
  deletions: number
  deleted: boolean
}

export const LARGE_DELETION_LINES = 200

const RISK_LABELS: Record<RiskKind, string> = {
  secrets: 'Secrets or env file',
  migration: 'Database migration',
  ci: 'CI or deploy config',
  lockfile: 'Dependency lockfile',
  deletion: 'Large deletion',
  unexpected: 'Outside the plan'
}

const RISK_ORDER: RiskKind[] = ['secrets', 'migration', 'ci', 'lockfile', 'deletion', 'unexpected']

const LOCKFILES = new Set([
  'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lockb', 'bun.lock',
  'Cargo.lock', 'poetry.lock', 'Pipfile.lock', 'uv.lock', 'Gemfile.lock', 'composer.lock', 'go.sum', 'mix.lock', 'Podfile.lock'
])

export function patchFileStats(patch: string): PatchFileStat[] {
  const files: PatchFileStat[] = []
  let current: PatchFileStat | null = null
  for (const line of patch.split('\n')) {
    const header = /^diff --git a\/(.+?) b\/(.+)$/.exec(line)
    if (header) {
      current = { path: header[2], additions: 0, deletions: 0, deleted: false }
      files.push(current)
    } else if (!current) continue
    else if (line.startsWith('deleted file mode')) current.deleted = true
    else if (line.startsWith('+') && !line.startsWith('+++ ')) current.additions += 1
    else if (line.startsWith('-') && !line.startsWith('--- ')) current.deletions += 1
  }
  return files
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}

function fileRisks(file: PatchFileStat, expected: Set<string> | null): RiskKind[] {
  const path = file.path
  const name = basename(path)
  const lower = path.toLowerCase()
  const risks: RiskKind[] = []
  if ((/^\.env(\..+)?$/.test(name) && !/\.(example|sample|template)$/.test(name)) || /\.(pem|key|p12|pfx)$/.test(lower) || /^id_(rsa|ed25519|ecdsa)$/.test(name)) {
    risks.push('secrets')
  }
  if (/(^|\/)migrations?\//.test(lower) || lower.endsWith('.sql')) risks.push('migration')
  if (lower.startsWith('.github/workflows/') || lower.startsWith('.circleci/') || name === '.gitlab-ci.yml' ||
    name === 'Dockerfile' || name === 'docker-compose.yml' || name === 'compose.yaml' || name === 'electron-builder.yml') {
    risks.push('ci')
  }
  if (LOCKFILES.has(name)) risks.push('lockfile')
  if (file.deleted || file.deletions >= LARGE_DELETION_LINES) risks.push('deletion')
  if (expected && !expected.has(path) && !LOCKFILES.has(name)) risks.push('unexpected')
  return risks
}

/** Changes worth a human look before shipping, ordered from most to least sensitive. */
export function taskRiskFlags(patch: string, expectedFiles?: string[]): RiskFlag[] {
  const expected = expectedFiles?.length ? new Set(expectedFiles.map((path) => path.replace(/\\/g, '/').replace(/^\.\//, ''))) : null
  const byKind = new Map<RiskKind, string[]>()
  for (const file of patchFileStats(patch)) {
    for (const kind of fileRisks(file, expected)) byKind.set(kind, [...(byKind.get(kind) ?? []), file.path])
  }
  return RISK_ORDER.filter((kind) => byKind.has(kind)).map((kind) => ({ kind, label: RISK_LABELS[kind], files: byKind.get(kind)! }))
}
