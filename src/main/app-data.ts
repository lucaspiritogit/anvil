import { isAbsolute, join, normalize } from 'node:path'

/** Packaged app data stays in place; source runs and explicit test profiles are separate. */
export function resolveAppDataDirectory(home: string, isPackaged: boolean, override?: string): string {
  if (override) {
    if (!isAbsolute(override)) throw new Error('ANVIL_DATA_DIR must be an absolute path')
    return normalize(override)
  }
  return join(home, isPackaged ? '.anvil-composer' : '.anvil-composer-dev')
}
