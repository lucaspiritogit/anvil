const { spawnSync } = require('node:child_process')
const { cpSync, mkdirSync, readFileSync, rmSync } = require('node:fs')
const { dirname, join } = require('node:path')

function prepareHeadlessSqlite() {
  const packagePath = require.resolve('better-sqlite3/package.json')
  const source = dirname(packagePath)
  const version = JSON.parse(readFileSync(packagePath, 'utf8')).version
  // Exact Node versions matter even when two releases share the same ABI.
  const fingerprint = [version, process.versions.node, process.versions.modules, process.platform, process.arch].join('-')
  const destination = join(__dirname, '../node_modules/.anvil-headless-native', fingerprint, 'better-sqlite3')
  const binding = join(destination, 'build/Release/better_sqlite3.node')
  const Database = require('better-sqlite3')

  function openBinding() {
    const database = new Database(':memory:', { nativeBinding: binding })
    database.close()
  }

  try {
    openBinding()
    return binding
  } catch {
    // Missing or unusable cache entries are rebuilt for this Node runtime.
  }

  console.log(`Preparing headless SQLite for Node ${process.versions.node} (ABI ${process.versions.modules})…`)
  rmSync(destination, { recursive: true, force: true })
  mkdirSync(destination, { recursive: true })
  cpSync(source, destination, {
    recursive: true,
    filter: (path) => path !== join(source, 'build') && path !== join(source, 'node_modules')
  })

  const environment = { ...process.env }
  // Do not let a prior Electron build select Electron headers for host Node.
  for (const key of Object.keys(environment)) {
    if (['npm_config_runtime', 'npm_config_target', 'npm_config_disturl', 'npm_config_dist_url', 'npm_config_nodedir'].includes(key.toLowerCase())) {
      delete environment[key]
    }
  }
  const result = spawnSync(process.execPath, [
    require.resolve('node-gyp/bin/node-gyp.js'), 'rebuild', '--directory', destination,
    `--target=${process.versions.node}`, '--dist-url=https://nodejs.org/download/release'
  ], { stdio: 'inherit', env: environment })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error('Could not build headless SQLite. Install Python and the C/C++ build tools for this server, then retry.')
  }
  openBinding()
  console.log('Headless SQLite is ready.')
  return binding
}

module.exports = { prepareHeadlessSqlite }

if (require.main === module) {
  try {
    prepareHeadlessSqlite()
  } catch (error) {
    console.error(error)
    process.exitCode = 1
  }
}
