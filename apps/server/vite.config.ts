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
const copyRuntimeAssets: Plugin = {
  name: 'copy-runtime-assets',
  async closeBundle() {
    for (const folder of ['db', 'memory']) {
      await cp(
        resolve(import.meta.dirname, `src/${folder}/migrations`),
        resolve(import.meta.dirname, `../../out/server/${folder}/migrations`),
        { recursive: true }
      )
    }
    await cp(
      resolve(import.meta.dirname, '../../out/renderer'),
      resolve(import.meta.dirname, '../../out/server/public'),
      { recursive: true }
    )
  }
}

export default defineConfig({
  plugins: [forbidElectron, copyRuntimeAssets],
  publicDir: false,
  ssr: {
    // The OpenCode SDK only publishes ESM exports. Bundle it so this server's
    // CommonJS output never asks Node or Electron to require the package.
    noExternal: ['@anvil/app-data', '@anvil/protocol', '@opencode-ai/sdk']
  },
  build: {
    ssr: resolve(import.meta.dirname, 'src/index.ts'),
    outDir: resolve(import.meta.dirname, '../../out/server'),
    emptyOutDir: true,
    target: 'node22',
    sourcemap: true,
    rollupOptions: {
      output: { format: 'cjs', entryFileNames: 'index.js' }
    }
  }
})
