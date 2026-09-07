import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, realpath, rm, unlink, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createPackageWithOptions } from '@electron/asar'
import { buildValence } from '../scripts/build-valence'
import { exposeValenceLauncher, installValenceLauncher } from '../src/main/valence/launcher'

async function main(): Promise<void> {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "anvil vl's bundle-")))
  const originalHome = process.env.HOME
  const originalUserProfile = process.env.USERPROFILE
  process.env.HOME = directory
  process.env.USERPROFILE = directory
  try {
    const application = join(directory, 'application')
    await buildValence(join(application, 'out'))
    await writeFile(join(application, 'package.json'), '{"name":"anvil-bundle-test","version":"1.0.0"}')
    // Package only production runtime modules. No valence or inquirer installation,
    // host NODE_PATH, or system Node is available to satisfy missing bundle imports.
    for (const dependency of ['better-sqlite3', 'bindings', 'file-uri-to-path', 'drizzle-orm']) {
      await cp(resolve('node_modules', dependency), join(application, 'node_modules', dependency), { recursive: true })
    }
    const archive = join(directory, 'app.asar')
    await createPackageWithOptions(application, archive, { unpackDir: 'node_modules/better-sqlite3' })
    await rm(application, { recursive: true, force: true })
    const binDirectory = join(directory, 'bin')
    installValenceLauncher(binDirectory, process.execPath, join(archive, 'out/main/valence-cli.js'))
    const environment = { ...process.env, NODE_PATH: undefined, ELECTRON_RUN_AS_NODE: undefined, HOME: directory, USERPROFILE: directory }
    exposeValenceLauncher(binDirectory, environment)
    assert.ok(environment.PATH?.startsWith(binDirectory))
    const windowsEnvironment = { Path: 'original' }
    exposeValenceLauncher(binDirectory, windowsEnvironment)
    assert.ok(windowsEnvironment.Path.endsWith('original'))
    assert.equal('PATH' in windowsEnvironment, false)
    assert.match(await readFile(join(binDirectory, 'vl.cmd'), 'utf8'), /set "ELECTRON_RUN_AS_NODE=1"/)

    const project = join(directory, 'project with spaces')
    const worktree = join(directory, 'worktree')
    await mkdir(project)
    await mkdir(worktree)
    const run = (...commandArguments: string[]) => spawnSync(
      process.platform === 'win32' ? 'vl' : '/bin/sh',
      process.platform === 'win32'
        ? commandArguments.map((argument) => `"${argument}"`)
        : ['-c', 'exec vl "$@"', 'vl', ...commandArguments],
      { cwd: worktree, env: environment, encoding: 'utf8', timeout: 15_000, shell: process.platform === 'win32' }
    )
    const cli = (...commandArguments: string[]): any => {
      const result = run('--project', project, ...commandArguments, '--json')
      assert.equal(result.status, 0, result.error?.message ?? result.stderr)
      return JSON.parse(result.stdout)
    }
    const help = run('--help').stdout
    assert.match(help, /Valence/)
    assert.match(help, /Optional: vl --project/)
    assert.match(help, /--project selects project context, not project-local storage/)
    assert.ok(help.includes('~/.config/valence/<project-name>/sqlite.db (default)'))
    assert.doesNotMatch(help, /defaults to local storage/)
    assert.equal(run('--version').stdout.trim(), '0.1.0')
    assert.equal(run('not-a-command').status, 1)
    assert.equal(run('--project').status, 1)
    assert.equal(run('--project', project, 'list').status, 1, 'Read commands must not initialize storage')
    assert.equal(existsSync(join(project, '.valence')), false)
    assert.equal(cli('init').database, join(directory, '.config/valence/project with spaces/sqlite.db'))
    assert.equal(existsSync(join(project, '.valence')), false, 'Default initialization must stay outside the repository')
    await writeFile(join(worktree, 'issue.json'), JSON.stringify({
      title: "Agent's bundled CLI issue", description: 'Use the original tracker',
      checklist: ['Validate bundled CLI'], validation: 'Run the packaged CLI test'
    }))
    const issue = cli('create', '--file', 'issue.json')
    assert.equal(cli('show', issue.id).title, "Agent's bundled CLI issue")
    cli('start', issue.id)
    cli('block', issue.id)
    assert.equal(cli('show', issue.id).status, 'blocked')
    cli('requeue', issue.id)
    cli('start', issue.id)
    await writeFile(join(worktree, 'completion.json'), JSON.stringify({ checklist: [true], evidence: 'Packaged CLI passed' }))
    cli('complete', issue.id, '--file=completion.json')
    assert.equal(cli('show', issue.id).evidence, 'Packaged CLI passed')
    assert.equal(existsSync(join(worktree, '.valence')), false, 'Do not create a worktree tracker')

    const library = require(join(archive, 'out/valence/dist/index.js')) as typeof import('valence')
    const tracker = library.openTracker(project)
    assert.equal(tracker.get(issue.id).status, 'complete', 'Bundled library and CLI share storage')
    tracker.close()
    const configProject = join(directory, 'config-project')
    await mkdir(configProject)
    const initialized = run('--project', configProject, 'init', '--config', '--json')
    assert.equal(initialized.status, 0, initialized.stderr)
    assert.equal(JSON.parse(initialized.stdout).database, join(directory, '.config/valence/config-project/sqlite.db'))
    assert.equal(run('--project', configProject, 'list', '--json').stdout.trim(), '[]')
    const localProject = join(directory, 'local-project')
    await mkdir(localProject)
    const local = run('--project', localProject, 'init', '--local', '--json')
    assert.equal(local.status, 0, local.stderr)
    assert.equal(JSON.parse(local.stdout).database, join(localProject, '.valence/sqlite.db'))
    assert.equal(run('--project', localProject, 'list', '--json').stdout.trim(), '[]')
    console.log('Valence bundle passed: ASAR, native SQLite, PATH launcher, help, errors, local/config storage, worktree input files, and issue updates.')
  } finally {
    if (originalHome === undefined) delete process.env.HOME
    else process.env.HOME = originalHome
    if (originalUserProfile === undefined) delete process.env.USERPROFILE
    else process.env.USERPROFILE = originalUserProfile
    // Electron treats ASAR files as directories during recursive traversal.
    await unlink(join(directory, 'app.asar')).catch(() => {})
    await rm(directory, { recursive: true, force: true })
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
