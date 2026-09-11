import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  main: {
    build: {
      externalizeDeps: {
        exclude: ['@agentclientprotocol/sdk']
      },
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/client/main/index.ts') }
      }
    }
  },
  preload: {
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/client/preload/index.ts') }
      }
    }
  },
  renderer: {
    root: resolve(__dirname, 'src/client/renderer'),
    resolve: {
      alias: {
        '@shared': resolve(__dirname, 'src/shared'),
        '@renderer': resolve(__dirname, 'src/client/renderer/src'),
        '@public': resolve(__dirname, 'public')
      }
    },
    plugins: [react(), tailwindcss()],
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/client/renderer/index.html') }
      }
    }
  }
})
