import Database from 'better-sqlite3'
import { Store } from '../../src/main/store'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, realpath, rm, unlink, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createPackageWithOptions, listPackage } from '@electron/asar'
import { buildValence } from '../../scripts/build-valence'
import { exposeValenceLauncher, installValenceLauncher } from '../../src/main/valence/launcher'

export async function run(): Promise<void> {
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
    await cp(resolve('src/main/db/migrations'), join(application, 'src/main/db/migrations'), { recursive: true })
    const archive = join(directory, 'app.asar')
    await createPackageWithOptions(application, archive, { unpackDir: 'node_modules/better-sqlite3' })
    const entries = listPackage(archive, { isPack: false })
    assert.ok(entries.some((entry) => entry.endsWith('/src/main/db/migrations/meta/_journal.json')))
    assert.ok(!entries.some((entry) => /valence[\/]drizzle|@lpirito|valence[\/]package.json/.test(entry)))
    assert.equal(entries.filter((entry) => entry.endsWith('/meta/_journal.json')).length, 1)
    await rm(application, { recursive: true, force: true })
    const binDirectory = join(directory, 'bin')
    const databasePath = join(directory, 'anvil.db')
    installValenceLauncher(binDirectory, process.execPath, join(archive, 'out/main/valence-cli.js'), databasePath)
    const environment: NodeJS.ProcessEnv = { ...process.env, NODE_PATH: undefined, ELECTRON_RUN_AS_NODE: undefined, HOME: directory, USERPROFILE: directory, PATH: '' }
    for (const key of Object.keys(environment)) {
      if (key.toUpperCase() === 'PATH') delete environment[key]
    }
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
    assert.match(help, /parent create/)
    assert.ok(JSON.parse(run('--help', '--json').stdout).commands.status)
    assert.match(help, /--anvil-task-id/)
    assert.equal(run('--version').stdout.trim(), '0.1.0')
    assert.equal(run('not-a-command').status, 1)
    assert.equal(run('--project').status, 1)
    assert.equal(run('--project', project, 'status', '--json').status, 1)
    assert.equal(existsSync(databasePath), false, 'Status must not create storage')
    const store = new Store(databasePath, { migrationsFolder: join(archive, 'src/main/db/migrations') })
    const db = new Database(databasePath)
    db.prepare('INSERT INTO projects (id, name, path, created_at) VALUES (?, ?, ?, 1)').run('project', 'Project', project)
    for (const id of ['task', 'other']) db.prepare(`INSERT INTO tasks
      (id, project_id, agent_id, agent_label, prompt, title, cwd, status, started_at)
      VALUES (?, 'project', 'codex', 'Codex', 'Prompt', 'Title', ?, 'running', 1)`).run(id, project)
    const tracker = store.issueTracker('project')
    try {
      assert.equal(cli('init').database, databasePath)
      assert.equal(cli('status').initialized, true)
      await writeFile(join(worktree, 'issue.json'), JSON.stringify({
        parentId: cli('parent', 'create', 'Bundled task', '--anvil-task-id', 'task').id, title: "Agent's bundled CLI issue", description: 'Use the original tracker',
        checklist: ['Validate bundled CLI'], validation: 'Run the packaged CLI test'
      }))
      const issue = cli('create', '--file', 'issue.json')
      assert.equal(cli('show', issue.id).title, "Agent's bundled CLI issue")
      assert.deepEqual(cli('list', '--parent', issue.parentId), [issue])
      const otherParent = cli('parent', 'create', 'Unrelated task', '--anvil-task-id', 'other')
      assert.equal(cli('claim', '--parent', otherParent.id), null)
      cli('start', issue.id)
      cli('block', issue.id)
      assert.equal(cli('show', issue.id).status, 'blocked')
      cli('requeue', issue.id)
      cli('start', issue.id)
      await writeFile(join(worktree, 'completion.json'), JSON.stringify({ checklist: [true], evidence: 'Packaged CLI passed' }))
      cli('complete', issue.id, '--file=completion.json')
      assert.equal(cli('show', issue.id).evidence, 'Packaged CLI passed')
      assert.equal(existsSync(join(worktree, '.valence')), false, 'Do not create a worktree tracker')

      assert.equal(tracker.get(issue.id).status, 'complete', 'App core and bundled CLI share storage')
      tracker.updateParent(issue.parentId, { description: 'Changed by Anvil' })
      assert.equal(cli('parent', 'show', issue.parentId).description, 'Changed by Anvil')
      assert.equal(tracker.getParent(issue.parentId).anvilTaskId, 'task')
      assert.equal(run('--project', project, 'init', '--config', '--json').status, 1)
      assert.equal(run('--project', project, 'init', '--local', '--json').status, 1)
    } finally {
      db.close()
      store.close()
    }
    console.log('Valence bundle passed: ASAR, native SQLite, PATH launcher, shared storage, worktree input files, and issue updates.')
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
