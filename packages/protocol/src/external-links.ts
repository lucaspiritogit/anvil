export const DITHER_KIT_URL = 'https://www.tripwire.sh/dither-kit'

export const ANVIL_REPOSITORY_URL = 'https://github.com/lucaspiritogit/anvil'
export const ANVIL_RELEASES_URL = `${ANVIL_REPOSITORY_URL}/releases/latest`
export const ANVIL_UPDATE_FEED_URL = 'https://pub-902a1faca35b4a8a8e268e9829ec6aab.r2.dev'

const ANVIL_REPOSITORY_PATH = '/lucaspiritogit/anvil'

export function isAnvilRepositoryUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 2_048) return false
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && url.hostname === 'github.com' && !url.username && !url.password && !url.port &&
      (url.pathname === ANVIL_REPOSITORY_PATH || url.pathname.startsWith(`${ANVIL_REPOSITORY_PATH}/`)) &&
      url.href === value
  } catch {
    return false
  }
}
