import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { resolve } from 'node:path'

export default defineConfig({
  publicDir: false,
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@shared': resolve('src/shared'), '@public': resolve('public') } },
  server: { host: '127.0.0.1', port: 4174, strictPort: true }
})
