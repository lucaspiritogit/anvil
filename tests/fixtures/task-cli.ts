import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtempSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { buildValence } from '../../scripts/build-valence'
import { onTestCleanup } from '../test-cleanup'

/** Execute the shipped CLI with Electron's SQLite addon against a live task store. */
export async function taskCli(database: string, project: string) {
  const directory = mkdtempSync(join(tmpdir(), 'anvil-task-cli-'))
  onTestCleanup(() => rmSync(directory, { recursive: true, force: true }))
  await buildValence(directory)
  const electron = createRequire(import.meta.url)('electron') as string
  return (...args: string[]): unknown => JSON.parse(execFileSync(electron, [
    join(directory, 'main/valence-cli.js'), '--project', project, ...args, '--json'
  ], {
    encoding: 'utf8',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', ANVIL_DATABASE_PATH: database,
      NODE_PATH: resolve('node_modules') }
  }))
}
