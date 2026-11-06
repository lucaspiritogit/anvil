import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'

const repositoryRoot = resolve(import.meta.dirname, '../..')

function resolveBuildSha(): string {
  const override = process.env.ANVIL_BUILD_SHA?.trim()
  if (override) return override
  try {
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: repositoryRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim()
    return /^[0-9a-f]{40}$/i.test(sha) ? sha.toLowerCase() : 'unknown'
  } catch {
    return 'unknown'
  }
}

function resolveBuildVersion(): string {
  const override = process.env.ANVIL_BUILD_VERSION?.trim()
  if (override) return override
  try {
    const manifest = JSON.parse(readFileSync(resolve(repositoryRoot, 'package.json'), 'utf8')) as { version?: unknown }
    return typeof manifest.version === 'string' && manifest.version ? manifest.version : 'unknown'
  } catch {
    return 'unknown'
  }
}

export default defineConfig({
  root: import.meta.dirname,
  publicDir: false,
  define: {
    __ANVIL_BUILD_SHA__: JSON.stringify(resolveBuildSha()),
    __ANVIL_BUILD_VERSION__: JSON.stringify(resolveBuildVersion())
  },
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
