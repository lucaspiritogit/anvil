import { build } from 'esbuild'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'

// Electron-only integration checks must execute in Electron, with its native
// addon and ASAR filesystem. Do not run Vitest itself under Electron's Node 20.
export async function runElectronFixture(entry: string): Promise<string> {
  const require = createRequire(import.meta.url)
  const electron = require('electron') as string
  const directory = await mkdtemp(join(tmpdir(), 'anvil-electron-fixture-'))
  try {
    const home = join(directory, 'home')
    await mkdir(home)
    const outfile = join(directory, 'fixture.cjs')
    await build({
      entryPoints: [entry], outfile, bundle: true, platform: 'node', format: 'cjs', packages: 'external',
      footer: { js: 'module.exports.run().catch(error => { console.error(error); process.exitCode = 1 })' }
    })
    return await new Promise<string>((resolveResult, reject) => {
      const child = spawn(electron, [outfile], {
        env: { ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, '.config'),
          APPDATA: join(home, 'AppData'), LOCALAPPDATA: join(home, 'LocalAppData'),
          ANVIL_TEST_HOME: home, ANVIL_DATA_DIR: undefined, ANVIL_DATABASE_PATH: undefined, ELECTRON_RUN_AS_NODE: '1',
          ANVIL_TEST_NODE: process.execPath, NODE_PATH: resolve('node_modules') },
        stdio: ['ignore', 'pipe', 'pipe']
      })
      let output = ''
      let timedOut = false
      const timeout = setTimeout(() => { timedOut = true; child.kill('SIGKILL') }, 45_000)
      child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString() })
      child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString() })
      child.on('error', (error) => { clearTimeout(timeout); reject(error) })
      child.on('close', (code) => {
        clearTimeout(timeout)
        if (code === 0 && !timedOut) resolveResult(output)
        else reject(new Error(`Electron fixture ${timedOut ? 'timed out' : `exited ${code}`}\n${output}`))
      })
    })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}
