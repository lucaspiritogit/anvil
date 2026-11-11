export const UNKNOWN_BUILD_VALUE = 'unknown'

export type BuildInfo = {
  sha: string
  shortSha: string
  version: string
  releaseBuild: boolean
}

const COMMIT_SHA_PATTERN = /^[0-9a-f]{40}$/i

function readSha(): string {
  const value = typeof __ANVIL_BUILD_SHA__ === 'string' ? __ANVIL_BUILD_SHA__.trim().toLowerCase() : ''
  return COMMIT_SHA_PATTERN.test(value) ? value : UNKNOWN_BUILD_VALUE
}

function readVersion(): string {
  const value = typeof __ANVIL_BUILD_VERSION__ === 'string' ? __ANVIL_BUILD_VERSION__.trim() : ''
  return value || UNKNOWN_BUILD_VALUE
}

const sha = readSha()
const version = readVersion()
const releaseBuild = typeof __ANVIL_RELEASE_BUILD__ === 'boolean' && __ANVIL_RELEASE_BUILD__ && version !== UNKNOWN_BUILD_VALUE

export const buildInfo: Readonly<BuildInfo> = Object.freeze({
  sha,
  shortSha: sha === UNKNOWN_BUILD_VALUE ? sha : sha.slice(0, 7),
  version,
  releaseBuild
})

export function isKnownBuildSha(value: string): boolean {
  return COMMIT_SHA_PATTERN.test(value)
}
