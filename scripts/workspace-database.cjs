const { existsSync, readFileSync } = require('node:fs')
const { isAbsolute, join } = require('node:path')

// Maintenance commands target the selected workspace, just like the app launcher.
module.exports = function workspaceDatabase(dataDirectory = require('./app-data.cjs')) {
  const override = process.env.ANVIL_DATABASE_PATH
  if (override) {
    if (!isAbsolute(override) || !override.endsWith('.db')) throw new Error('ANVIL_DATABASE_PATH must be an absolute workspace database path')
    return override
  }
  const configFile = join(dataDirectory, 'config.json')
  let name = 'Default'
  if (existsSync(configFile)) {
    const config = JSON.parse(readFileSync(configFile, 'utf8'))
    if (config.version !== 1 || !Array.isArray(config.workspaces)) throw new Error('Invalid root config')
    const workspace = config.workspaces.find((entry) => entry.id === config.activeWorkspaceId)
      ?? config.workspaces.find((entry) => entry.id === 'default')
    if (!workspace) throw new Error('Selected workspace not found')
    name = workspace.name
    if (typeof name !== 'string' || !name.trim() || name === '.' || name === '..'
      || /[<>:"/\\|?*\x00-\x1f\x7f]/.test(name) || /[. ]$/.test(name)) throw new Error('Invalid workspace folder name')
  }
  return join(dataDirectory, 'workspaces', name, 'anvil.db')
}
