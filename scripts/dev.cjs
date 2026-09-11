const path = require('node:path')
const { pathToFileURL } = require('node:url')

async function main() {
  await import('./build-server.mjs')
  delete process.env.ELECTRON_RUN_AS_NODE

  // Electron 44 downloads its binary on require. electron-vite reads path.txt
  // directly, so resolve Electron first to support a fresh npm install.
  if (!process.env.ELECTRON_EXEC_PATH) {
    process.env.ELECTRON_EXEC_PATH = require('electron')
  }

  const vitePackagePath = require.resolve('electron-vite/package.json')
  const vitePackage = require(vitePackagePath)
  const viteCliPath = path.join(path.dirname(vitePackagePath), vitePackage.bin['electron-vite'])
  process.argv.splice(1, 1, viteCliPath, 'dev')
  await import(pathToFileURL(viteCliPath).href)
}

main().catch((error) => {
  console.error('[anvil dev]', error.message)
  process.exitCode = 1
})
