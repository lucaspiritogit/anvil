// npm test and its aliases run this before Vitest. Postinstall builds the installed
// better-sqlite3 addon for Electron, whose native module ABI differs from host Node.
// Vitest runs on host Node, so it needs a separately compiled SQLite addon.
// This script builds that copy in node_modules/.anvil-vitest-native; the test setup
// in tests/vitest.setup.ts loads it while Electron keeps its installed binary.
// Reuse requires a matching package version, exact Node version, ABI, platform and architecture,
// plus a successful database open. A missing or unusable copy is rebuilt locally.
// See docs/testing/vitest-migration.md for native prerequisites and cleanup.

import { createRequire } from 'node:module'
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const require = createRequire(import.meta.url)
const [major, minor] = process.versions.node.split('.').map(Number)
if (!(major === 22 && minor >= 12 || major === 24 || major >= 26)) {
  throw new Error(`Vitest requires Node ^22.12.0 || ^24.0.0 || >=26.0.0; got ${process.version}`)
}
// Build a private copy. Never rebuild the Electron application's installed addon.
const source = resolve('node_modules/better-sqlite3')
const destination = resolve('node_modules/.anvil-vitest-native/better-sqlite3')
const version = JSON.parse(await readFile(join(source, 'package.json'), 'utf8')).version
// Node header changes can affect native behavior without changing the module ABI.
const fingerprint = `${version}:${process.versions.node}:${process.versions.modules}:${process.platform}:${process.arch}`
const stamp = join(destination, '.anvil-runtime')
let ready = false
try {
  ready = await readFile(stamp, 'utf8') === fingerprint
  if (ready) {
    const Database = require(destination)
    const database = new Database(':memory:')
    database.close()
  }
} catch { ready = false }
if (!ready) {
  await rm(destination, { recursive: true, force: true })
  await mkdir(destination, { recursive: true })
  await cp(source, destination, { recursive: true, filter: (path) => path !== join(source, 'build') && path !== join(source, 'node_modules') })
  const result = spawnSync(process.execPath, [require.resolve('node-gyp/bin/node-gyp.js'), 'rebuild', '--directory', destination,
    `--target=${process.versions.node}`, '--dist-url=https://nodejs.org/download/release'], { stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`Host SQLite build failed (${result.status})`)
  const Database = require(destination)
  const database = new Database(':memory:')
  database.close()
  await writeFile(stamp, fingerprint)
}
console.log(`Vitest SQLite ready: Node ${process.versions.node}, ABI ${process.versions.modules}, better-sqlite3 ${version}`)
