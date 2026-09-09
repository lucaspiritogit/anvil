// Inspect a packaged app without launching it or opening user databases.
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { extractFile, listPackage } from '@electron/asar'

const application = process.argv[2]
if (!application) throw new Error('Usage: node scripts/verify-embedded-tracker-package.mjs /path/to/Anvil.app')
const archive = join(application, 'Contents/Resources/app.asar')
const entries = listPackage(archive)
assert(!entries.some((entry) => /^\/out\/valence(?:\/|$)/.test(entry)), 'Package still ships the obsolete standalone Valence distribution')
for (const path of ['out/main/index.js', 'out/main/valence-cli.js']) {
  const code = extractFile(archive, path).toString()
  assert(!/importLegacyPlans|Legacy parent missing|legacy-import\.ts/.test(code), `${path} still contains the standalone importer`)
  assert(!/['"]\.config['"],\s*['"]valence['"]|\.config\/valence/.test(code), `${path} still references standalone config storage`)
  assert(code.includes('ANVIL_DATABASE_PATH'), `${path} must pin the CLI to Anvil's database`)
}
console.log('Package passed: embedded Anvil SQLite only; no standalone Valence distribution or importer')
