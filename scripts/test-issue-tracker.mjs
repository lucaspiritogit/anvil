import { build } from 'esbuild'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import electron from 'electron'

const availableSuites = ['agent-models', 'model-options', 'valence-bundle', 'valence-integration', 'valence-clients', 'issue-tracker', 'issue-tracker-git', 'git-delivery', 'git-merge', 'github-git', 'github-pull-requests', 'pull-request-draft', 'task-deletion', 'task-settlement', 'task-prompts', 'task-usage', 'task-steering', 'task-recovery', 'steering-settled', 'db-cli', 'ipc-handlers', 'agent-process-manager', 'agent-reasoning-forwarding', 'agent-cli-reasoning-effort', 'opencode-acp', 'codex-app-server', 'codex-sandbox', 'agent-server-lifecycle', 'app-shutdown', 'agent-output', 'agent-streaming-output']
const requestedSuites = process.argv.slice(2)
const suites = requestedSuites.length ? requestedSuites : availableSuites
for (const suite of suites) {
  if (!availableSuites.includes(suite)) throw new Error(`Unknown test suite: ${suite}`)
}

const directory = await mkdtemp(join(tmpdir(), 'anvil-issue-tracker-suite-'))
try {
  for (const suite of suites) {
  const outfile = join(directory, 'issue-tracker-test.cjs')
  await build({
    entryPoints: [`tests/${suite}.test.ts`], outfile, bundle: true, platform: 'node', format: 'cjs',
    packages: 'external', plugins: [{
      name: 'issue-tracker-test-doubles',
      setup(build) {
        // The ACP SDK is ESM-only; Electron 33's Node runtime needs it bundled.
        build.onResolve({ filter: /^@agentclientprotocol\/sdk$/ }, () => ({ path: resolve('node_modules/@agentclientprotocol/sdk/dist/acp.js') }))
        build.onResolve({ filter: /^(electron|\.{1,2}\/agents\/(process-manager|models)|\.{1,2}\/git-delivery|\.{1,2}\/terminal|\.{1,2}\/memory\/project-memory)$/ }, (args) => {
          if (['issue-tracker-git', 'git-delivery', 'git-merge', 'github-git'].includes(suite) && resolve(args.resolveDir, args.path) === resolve('src/main/git-delivery')) return undefined
          return { path: resolve('tests/issue-tracker-doubles.ts') }
        })
      }
    }]
  })
  const homeDirectory = join(directory, `${suite}-home`)
  await mkdir(homeDirectory)
  const result = spawnSync(electron, [outfile], {
    stdio: 'inherit', env: { ...process.env, HOME: homeDirectory, USERPROFILE: homeDirectory, ELECTRON_RUN_AS_NODE: '1', NODE_PATH: resolve('node_modules'), ANVIL_TEST_NODE: process.execPath }
  })
  if (result.error) throw result.error
  process.exitCode = result.status ?? 1
  if (process.exitCode) break
  }
} finally {
  await rm(directory, { recursive: true, force: true })
}
