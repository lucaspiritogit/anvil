import { resolve } from 'node:path'
import { buildValence } from './scripts/build-valence'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  main: {
    plugins: [{
      name: 'bundle-valence',
      async closeBundle() {
        await buildValence(resolve(__dirname, 'out'))
      }
    }],
    build: {
      externalizeDeps: {
        exclude: ['@ai-sdk/openai-compatible', 'ai', '@agentclientprotocol/sdk']
      },
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/main/index.ts') }
      }
    }
  },
  preload: {
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/preload/index.ts') }
      }
    }
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    resolve: {
      alias: {
        '@shared': resolve(__dirname, 'src/shared'),
        '@renderer': resolve(__dirname, 'src/renderer/src'),
        '@public': resolve(__dirname, 'public')
      }
    },
    plugins: [react(), tailwindcss()],
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/renderer/index.html') }
      }
    }
  }
})
