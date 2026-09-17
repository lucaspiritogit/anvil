# Contributing

## Requirements

- Node 24.15+
- At least one agent CLI on your PATH.
- Linux: Python 3, `make`, and a C++20 compiler such as GCC 10 or newer. `node-pty`
  builds locally because its npm package does not include Linux binaries.

Windows x64 and arm64 use the `node-pty` binaries included in its npm package.
They do not require Visual Studio Build Tools for a normal install.

## Run locally

```sh
npm install
npm run dev
```

Development runs use `~/.anvil-composer-dev/`. Packaged apps use
`~/.anvil-composer/`, preserving existing projects and settings. The SQLite
database, settings, GitHub credentials, wallpapers, and embedded project memory
are separate. Development starts with an empty project list.

For self-development, use the installed app to run an agent on the Anvil repo
and `npm run dev` to try its changes after merging the task branch. Both apps
can stay open. Tasks use separate worktrees while Valence issues belong to the
project checkout. A configured external PostgreSQL memory database also needs a
separate URL if you want to isolate it.

`npm run build` followed by `npm start` is still an unpackaged development run.
The split uses Electron's `app.isPackaged`, not Vite's build mode. For
disposable tests, set `ANVIL_DATA_DIR` to an absolute temporary directory before
launching either version. This also isolates its Electron profile. For example:

```sh
ANVIL_DATA_DIR="$(mktemp -d /tmp/anvil-test.XXXXXX)" npm run dev
```

## Checks

Run `npm run typecheck` to verify that the code works. Only run unit or
integration tests focused on the task to verify behavior; do not run the full
suite unless asked.

## Storage and migrations

App state lives in `~/.anvil-composer-dev/workspaces/<name>/anvil.db` during
development and `~/.anvil-composer/workspaces/<name>/anvil.db` in packaged apps,
via Drizzle on Node's built-in SQLite driver: projects, tasks, events, comments,
settings, and execution metadata. Valence is Anvil's internal issue tracker. Its
parents, issues, dependencies and validation evidence share this SQLite
database. Each parent references the real Anvil task through
`parent_issues.anvil_task_id`. Project memory has its own database.

| Database | Schema | Generate migrations |
| --- | --- | --- |
| App state | `src/server/db/schema.ts` | `npm run db:generate` |
| Project memory | `src/server/memory/schema.ts` | `npm run memory:generate` |

Commit schema changes and generated migrations together. Anvil applies pending
SQLite migrations on startup. To apply them without opening Anvil, quit the app
and run `npm run db:migrate`.

Repository database commands and `npm run memory:inspect` follow the selected
workspace in development storage. They share `scripts/maintenance.cjs`; PGlite
inspection reads that workspace's `memory/pglite` directory. Set
`ANVIL_DATA_DIR="$HOME/.anvil-composer"` explicitly to maintain the packaged
app's data after quitting that app.

## Reset app data

Quit the development app before running either command. Both delete its SQLite
app data and leave project memory untouched.

- `npm run db:drop` deletes `~/.anvil-composer-dev/workspaces/<name>/anvil.db`
  and its sidecar files, or the database under `ANVIL_DATA_DIR` when set.
- `npm run db:reset` drops the database and reapplies migrations. It creates the
  schema only; Anvil seeds default settings on its next startup.

## Commits and pull requests

Keep changes focused and use the prefixes `feat:`, `fix:`, `chore:`, or
`docs:`. PR descriptions should explain behavior, reference relevant issues,
report checks performed, and include screenshots for visible UI changes.
