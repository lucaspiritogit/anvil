import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  root: import.meta.dirname,
  publicDir: false,
  resolve: {
    alias: {
      '@dither-kit': resolve(import.meta.dirname, 'src/components/dither-kit'),
      '@renderer': resolve(import.meta.dirname, 'src'),
      '@public': resolve(import.meta.dirname, '../../public')
    }
  },
  plugins: [react(), tailwindcss()],
  build: {
    outDir: resolve(import.meta.dirname, '../../out/renderer'),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        index: resolve(import.meta.dirname, 'index.html'),
        closing: resolve(import.meta.dirname, 'closing.html')
      }
    }
  }
})
