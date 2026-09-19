import { DatabaseSync } from 'node:sqlite'
import { join, resolve } from 'node:path'
import { Store } from '../../apps/server/src/store'
import { IssueTracker } from '../../apps/server/src/valence/tracker'
import { onTestCleanup } from '../test-cleanup'

export function internalTrackerFixture(project: string) {
  const databasePath = join(project, 'config.json')
  const store = new Store(databasePath, { migrationsFolder: resolve('apps/server/src/db/migrations') })
  onTestCleanup(() => store.close())
const db = new DatabaseSync(store.getWorkspaceDatabasePath('default'))
  try {
    db.prepare('INSERT INTO projects (id, name, path, created_at) VALUES (?, ?, ?, 1)').run('project', 'Project', project)
    db.prepare(`INSERT INTO tasks (id, project_id, agent_id, agent_label, prompt, title, cwd, status, started_at)
      VALUES ('task', 'project', 'codex', 'Codex', 'Prompt', 'Title', ?, 'succeeded', 1)`).run(project)
  } finally { db.close() }
return { writer: store.issueTracker('project'), open: () => new IssueTracker(new DatabaseSync(store.getWorkspaceDatabasePath('default')), 'project', 'owned') }
}
