import { cp } from 'node:fs/promises'
import { resolve } from 'node:path'
import { defineConfig, type Plugin } from 'vite'

// The server runs under plain Node (or Electron with ELECTRON_RUN_AS_NODE) and
// must never pull in Electron APIs.
const forbidElectron: Plugin = {
  name: 'forbid-electron',
  enforce: 'pre',
  resolveId(id) {
    if (id === 'electron' || id.startsWith('electron/')) {
      throw new Error('The server cannot import Electron')
    }
    return null
  }
}

// Drizzle reads migration SQL from disk next to the bundle at runtime.
const copyMigrations: Plugin = {
  name: 'copy-migrations',
  async closeBundle() {
    for (const folder of ['db', 'memory']) {
      await cp(
        resolve(__dirname, `src/server/${folder}/migrations`),
        resolve(__dirname, `out/server/${folder}/migrations`),
        { recursive: true }
      )
    }
  }
}

export default defineConfig({
  plugins: [forbidElectron, copyMigrations],
  publicDir: false,
  build: {
    ssr: resolve(__dirname, 'src/server/index.ts'),
    outDir: 'out/server',
    emptyOutDir: true,
    target: 'node22',
    sourcemap: true,
    rollupOptions: {
      output: { format: 'cjs', entryFileNames: 'index.js' }
    }
  }
})
