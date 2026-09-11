import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [{
    name: 'anvil-orchestration-doubles',
    enforce: 'pre',
    resolveId(source, importer) {
      // Only orchestration imports used these doubles in the legacy runner.
      // Direct tests of src/main/agents/{process-manager,models} stay real.
      if (importer && !importer.endsWith('/agents/workspace-accounts.ts') && /^(\.{1,2}\/agents\/(process-manager|models)|\.{1,2}\/memory\/project-memory)$/.test(source)) {
        return resolve('tests/issue-tracker-doubles.ts')
      }
    }
  }],
  test: {
    include: ['tests/*.test.ts'],
    exclude: ['tests/e2e/**', 'tests/fixtures/**'],
    setupFiles: ['tests/vitest.setup.ts'],
    pool: 'forks',
    isolate: true,
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 30_000,
    restoreMocks: true,
    unstubEnvs: true,
    unstubGlobals: true
  }
})
