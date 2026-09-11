import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

// Keep new suites in integration until their dependencies are reviewed.
const unitSuites = [
  'tests/agent-failure.test.ts',
  'tests/app-lifecycle.test.ts',
  'tests/app-shutdown.test.ts',
  'tests/github-pull-requests.test.ts',
  'tests/image-headers.test.ts',
  'tests/model-options.test.ts',
  'tests/notification-delivery.test.ts',
  'tests/sidebar-task-stacks.test.ts',
  'tests/startup.test.ts',
  'tests/task-duration.test.ts',
  'tests/wallpaper-cache.test.ts',
  'tests/wallpapers.test.ts'
]

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
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: unitSuites,
          setupFiles: ['tests/vitest.unit.setup.ts'],
          fileParallelism: true,
          maxWorkers: 4
        }
      },
      {
        extends: true,
        test: {
          name: 'integration',
          include: ['tests/*.test.ts'],
          exclude: [...unitSuites, 'tests/e2e/**', 'tests/fixtures/**'],
          globalSetup: ['tests/vitest.integration.setup.ts'],
          setupFiles: ['tests/vitest.setup.ts'],
          fileParallelism: false
        }
      }
    ],
    pool: 'forks',
    isolate: true,
    testTimeout: 60_000,
    hookTimeout: 30_000,
    restoreMocks: true,
    unstubEnvs: true,
    unstubGlobals: true
  }
})
