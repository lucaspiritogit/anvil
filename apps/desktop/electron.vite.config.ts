import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'electron-vite'

const desktopDirectory = dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  main: {
    define: {
      __ANVIL_RELEASE_BUILD__: JSON.stringify(process.env.ANVIL_RELEASE_BUILD === '1')
    },
    build: {
      outDir: resolve(desktopDirectory, '../../out/main'),
      emptyOutDir: true,
      externalizeDeps: {
        exclude: ['@anvil/app-data', '@anvil/protocol']
      },
      rolldownOptions: {
        input: { index: resolve(desktopDirectory, 'src/main/index.ts') }
      }
    }
  },
  preload: {
    build: {
      outDir: resolve(desktopDirectory, '../../out/preload'),
      emptyOutDir: true,
      externalizeDeps: {
        exclude: ['@anvil/client-api', '@anvil/protocol']
      },
      rolldownOptions: {
        input: { index: resolve(desktopDirectory, 'src/preload/index.ts') }
      }
    }
  }
})
