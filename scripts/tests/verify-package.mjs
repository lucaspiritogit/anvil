// Inspect build contents without launching the app or opening user databases.
import assert from 'node:assert/strict'
import { globSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { extractFile, listPackage } from '@electron/asar'

const target = process.argv[2]
const candidates = target
  ? [target.endsWith('.asar') ? target : join(target, 'Contents/Resources/app.asar')]
  : globSync('release/**/app.asar')
assert(candidates.length, 'No packaged desktop app found')
for (const filename of candidates) {
  const archive = resolve(filename)
  const entries = listPackage(archive).map((entry) => entry.replaceAll('\\', '/'))
  for (const path of ['out/main/index.js', 'out/preload/index.js', 'out/server/index.js', 'out/renderer/index.html', 'out/renderer/closing.html']) {
    assert(entries.includes(`/${path}`), `Missing ${path}`)
  }
  for (const directory of ['db', 'memory']) {
    assert(entries.some((entry) => entry.startsWith(`/out/server/${directory}/migrations/`) && entry.endsWith('.sql')), `Missing ${directory} migrations`)
  }
  assert(!entries.some((entry) => /^\/out\/valence(?:\/|$)/.test(entry) || entry.endsWith('/valence-cli.js')), 'Obsolete tracker distribution is packaged')
  const server = extractFile(archive, 'out/server/index.js').toString()
  assert(server.includes('anvil_get_plan'), 'Server must include issue tools')
  assert(!/importLegacyPlans|Legacy parent missing|legacy-import\.ts/.test(server), 'Obsolete tracker importer is packaged')
  assert(!entries.some((entry) => entry.startsWith('/scripts/')), 'Development scripts must not ship')
  console.log(`Desktop package contents verified: ${archive}`)
}
