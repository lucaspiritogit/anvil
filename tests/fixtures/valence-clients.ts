import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import Database from 'better-sqlite3'
import { buildValence } from '../../scripts/build-valence'
import { Store } from '../../src/main/store'
import { installValenceLauncher } from '../../src/main/valence/launcher'

export async function run(): Promise<void> {
  const cleanup: (() => void)[] = []
  const onTestCleanup = (callback: () => void) => { cleanup.push(callback) }
  try {
    const home = process.env.ANVIL_TEST_HOME!
    const project = join(home, 'project with spaces')
    const worktree = join(home, 'worktree')
    mkdirSync(project)
    mkdirSync(worktree)
    const path = join(home, 'anvil.db')
    const store = new Store(path, { migrationsFolder: resolve('src/main/db/migrations') })
    onTestCleanup(() => store.close())
    const db = new Database(path)
    onTestCleanup(() => { db.close() })
    db.prepare('INSERT INTO projects (id, name, path, created_at) VALUES (?, ?, ?, 1)').run('project', 'Project', project)
    db.prepare('INSERT INTO projects (id, name, path, created_at) VALUES (?, ?, ?, 1)').run('other', 'Other', worktree)
    for (const [id, projectId] of [['task', 'project'], ['task2', 'project'], ['other-task', 'other']]) {
      db.prepare(`INSERT INTO tasks (id, project_id, agent_id, agent_label, prompt, title, cwd, status, started_at)
        VALUES (?, ?, 'codex', 'Codex', 'Prompt', 'Title', ?, 'running', 1)`).run(id, projectId, project)
    }
    const imageDirectory = `${path}.images/orphan-task`
    mkdirSync(imageDirectory, { recursive: true })
    writeFileSync(join(imageDirectory, 'keep.png'), 'sentinel')
    const core = store.issueTracker('project')
    await buildValence(home)
    const cliPath = join(home, 'main/valence-cli.js')
    const bin = join(home, "agent's bin")
    installValenceLauncher(bin, process.execPath, cliPath, path)
    const executable = process.platform === 'win32' ? join(bin, 'vl.cmd') : '/bin/sh'
    const args = (input: string[]) => {
      const values = ['--project', project, ...input, '--json']
      return process.platform === 'win32' ? values.map((value) => `"${value}"`) : [join(bin, 'vl'), ...values]
    }
    const options = { cwd: worktree, shell: process.platform === 'win32' }
    const run = (...input: string[]) => spawnSync(executable, args(input), { ...options, encoding: 'utf8' })
    const cli = (...input: string[]): any => {
      const result = run(...input)
      assert.equal(result.status, 0, result.stderr)
      return JSON.parse(result.stdout)
    }
    const fail = (...input: string[]) => {
      const result = run(...input)
      assert.equal(result.status, 1)
      assert.ok(JSON.parse(result.stderr).error)
    }
    assert.ok(cli('--help').help.includes('--anvil-task-id'))
    assert.equal(cli('status').database, path)
    assert.equal(cli('init').initialized, true)
    fail('init', '--local')
    fail('init', '--config')
    fail('parent', 'create', 'Missing task')
    fail('parent', 'create', 'Unknown task', '--anvil-task-id', 'missing')
    fail('parent', 'create', 'Wrong project', '--anvil-task-id', 'other-task')
    fail('unknown')
    fail('show')
    const parent = cli('parent', 'create', 'Plan', '--anvil-task-id', 'task')
    assert.equal(core.getParent(parent.id).anvilTaskId, 'task')
    const input = { parentId: parent.id, title: 'Issue', description: 'Description', checklist: ['Check'], validation: 'Test' }
    writeFileSync(join(worktree, 'issue input.json'), JSON.stringify(input))
    const issue = cli('create', '--file=issue input.json')
    assert.equal(core.get(issue.id).title, 'Issue')
    core.update(issue.id, { title: 'App edit' })
    assert.equal(cli('show', issue.id).title, 'App edit')
    cli('update', issue.id, '--label', 'cli', '--priority', 'urgent')
    assert.equal(cli('list', '--parent', parent.id).length, 1)
    assert.equal(cli('ready', '--parent', parent.id).length, 1)
    assert.equal(cli('parent', 'list').length, 1)
    assert.equal(cli('parent', 'update', parent.id, '--title', 'Revised plan').title, 'Revised plan')
    assert.equal(cli('parent', 'show', parent.id).title, 'Revised plan')
    writeFileSync(join(worktree, 'wrong parent.json'), JSON.stringify({ anvilTaskId: 'other-task', title: 'Wrong project' }))
    fail('parent', 'create', '--file', 'wrong parent.json')
    writeFileSync(join(worktree, 'parent input.json'), JSON.stringify({ anvilTaskId: 'task2', title: 'JSON plan' }))
    const jsonParent = cli('parent', 'create', '--file', 'parent input.json')
    assert.equal(core.getParent(jsonParent.id).anvilTaskId, 'task2')
    assert.equal(cli('claim', '--parent', jsonParent.id), null)
    const claim = () => new Promise<any>((resolveClaim, reject) => {
      const child = spawn(executable, args(['claim', '--parent', parent.id]), options)
      let stdout = ''; let stderr = ''
      child.stdout.on('data', (data) => { stdout += data })
      child.stderr.on('data', (data) => { stderr += data })
      child.on('error', reject)
      child.on('close', (code) => code === 0 ? resolveClaim(JSON.parse(stdout)) : reject(new Error(stderr)))
    })
    const claims = await Promise.all([claim(), claim()])
    assert.equal(claims.filter(Boolean).length, 1)
    assert.equal(core.get(issue.id).status, 'working')
    fail('submit-review', issue.id, '--confirm-checklist')
    cli('block', issue.id)
    cli('requeue', issue.id)
    cli('start', issue.id)
    writeFileSync(join(worktree, 'completion input.json'), JSON.stringify({ checklist: [true], evidence: 'Actual test evidence' }))
    cli('submit-review', issue.id, '--file', 'completion input.json')
    cli('approve', issue.id)
    assert.equal(existsSync(join(imageDirectory, 'keep.png')), true)
    assert.equal(core.get(issue.id).evidence, 'Actual test evidence')
    assert.deepEqual(db.prepare('SELECT status FROM tasks WHERE id = ?').get('task'), { status: 'running' })
    assert.equal(existsSync(join(project, '.valence')), false)
    assert.equal(existsSync(join(worktree, '.valence')), false)
    const missing = join(home, 'missing.db')
    for (const command of ['status', 'init', '--help']) {
      const result = spawnSync(process.execPath, [cliPath, '--project', project, command, '--json'], {
        encoding: 'utf8', env: { ...process.env, ANVIL_DATABASE_PATH: missing }
      })
      assert.equal(result.status, command === '--help' ? 0 : 1)
      assert.equal(existsSync(missing), false)
    }
    const otherPath = join(home, 'other-profile.db')
    const otherStore = new Store(otherPath, { migrationsFolder: resolve('src/main/db/migrations') })
    onTestCleanup(() => otherStore.close())
    const mismatch = spawnSync(process.execPath, [cliPath, '--project', project, 'status', '--json'], {
      encoding: 'utf8', env: { ...process.env, ANVIL_DATABASE_PATH: otherPath }
    })
    assert.equal(mismatch.status, 1)
    assert.ok(JSON.parse(mismatch.stderr).error.includes('registered Anvil project'))
    console.log('Valence clients passed: Electron SQLite, shared storage, profiles, atomic claims')
  } finally {
    for (const dispose of cleanup.reverse()) dispose()
  }
}
