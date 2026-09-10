const { spawnSync } = require('node:child_process')
const { join } = require('node:path')
const { homedir } = require('node:os')

if (process.platform === 'darwin') {
  const result = spawnSync(process.execPath, [
    require.resolve('node-gyp/bin/node-gyp.js'), 'rebuild',
    '--directory=native/mac-notifications',
    `--target=${require('electron/package.json').version}`,
    `--arch=${process.arch}`, '--dist-url=https://electronjs.org/headers',
    `--devdir=${join(homedir(), '.electron-gyp')}`
  ], { stdio: 'inherit' })
  if (result.error) throw result.error
  process.exit(result.status ?? 1)
}
