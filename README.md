# Anvil

An agentic development platform. No chats, clear tasks.

Anvil is a desktop app for putting coding agents to work on a project folder.
You write a task, dispatch it, and review a diff. There is no chat window and no
persona to interact with. An agent here is an instrument you point at a
problem, the same as a compiler or a test runner. The terminal is still one tab
away when you want to do the work yourself.

## Philosophy

**An agent is a tool.** Agents keep being dressed up as teammates: chat threads,
personalities, a conversation you steer turn by turn. That framing quietly moves
agency from the developer to the agent, and it changes what you end up with. You
get a transcript to read instead of a diff to review.

Researching and asking questions are completely valid ways to use AI. But
following an agent's suggestion without doing your own research means adopting
someone else's decision. You end up knowing the **why** you were given, without
the context to understand **what** you're actually building.

**The agent works the way you would.** It gets a worktree, a branch, and your
task. It uses Git normally and writes its own commit messages. Anvil asks it to
plan small issues and validate each one. It works through them sequentially,
then presents the whole task result and local diff for your review.

**Nothing is hidden.** The output log shows the agent's own output, its thinking,
its tool calls, its errors, and every Git command Anvil runs on your behalf.

## Architecture

Anvil is an Electron app. The main process owns the real work. The renderer is a
React UI that talks to it through a typed preload bridge.

```
┌─────────────┐  IPC  ┌──────────────┐  contextBridge  ┌────────────┐
│  main       │◄─────►│  preload     │◄───────────────►│  renderer  │
│  Node/Electron      │  typed API   │                 │  React UI  │
└─────────────┘       └──────────────┘                 └────────────┘
```

A typical task flows like this:

1. You describe work and pick an agent. Main creates a task in SQLite.
2. For Git projects, `GitDeliveryManager` creates a separate worktree and unique
   branch for each task. It snapshots current tracked edits and non-ignored new
   files without changing the source branch, files, or index. Runtime databases
   and `.env` files are excluded. The final diff compares against that snapshot,
   so inherited edits are not reported as the agent's work.
3. `AgentProcessManager` routes OpenCode through ACP and Codex through its app-server
   adapter. Both produce task events for persistence.
4. The agent creates up to 50 issues through `vl`, labeled with its Anvil task ID.
   Anvil reads that plan from Valence and claims only those issue IDs.
   Valence enforces dependencies and priority; Anvil runs
   one issue turn at a time, with no Board UI or per-issue approval.
5. When everything finishes, Anvil finalizes Git delivery and shows one
   cumulative local diff for review. Approve, comment, rebase, or settle from
   there.

Codex keeps the `workspace-write` sandbox. Each turn grants write access to its
worktree and Git metadata, plus networking for dependency installs and local test
servers. The source checkout and other task files are not additional writable
roots. Git metadata is shared by linked worktrees, so agents must keep Anvil's
assigned branch and avoid changing other branches. Install dependencies in the
task worktree; do not symlink another checkout's `node_modules` or build caches.

Token totals accumulate across model requests, including the planning and
implementation turns. Codex input includes cached tokens; cached input is shown
separately and is not added to the total again. Anvil does not resend its event
log. Codex manages its own tool history. Anvil disables Codex personal memory and
plugin recommendations per task, supplies project memory itself, and limits
stored tool output to 3,000 tokens per result. Agents can read additional file
ranges when needed.

**Storage.** App state lives in `~/.anvil-composer/anvil.db` via Drizzle on
better-sqlite3: projects, tasks, events, comments, settings, and execution metadata.
Issue records belong to Valence's separate project database. Anvil stores their
IDs and its current turn, not copies of their status, dependencies, or evidence.
Completed-task memory is separate. PGlite with pgvector is the desktop default.
PostgreSQL is available for self-hosted setups. Ollama generates embeddings
locally. Schema sources are `src/main/db/schema.ts` and
`src/main/memory/schema.ts`. Generate migrations with `npm run db:generate` and
`npm run memory:generate`.

## Requirements

- Node 20.19+
- At least one agent CLI on your PATH.

## Development

```
npm install
npm run dev
```

If your shell exports `ELECTRON_RUN_AS_NODE=1`, unset it first or Electron boots
as plain Node and never opens a window.

After changing the SQLite schema, run `npm run db:generate` and commit the
schema and generated migrations together. The app applies pending migrations
on startup. To apply them without opening Anvil, quit the app and run
`npm run db:migrate`. This runs Drizzle Kit under Electron's Node because
`better-sqlite3` is compiled for Electron. The launcher sets
`ELECTRON_RUN_AS_NODE=1`; it does not patch the database driver.

`npm run db:drop` deletes `~/.anvil-composer/anvil.db` and its WAL sidecar files.
`npm run db:reset` drops the database and reapplies migrations. Both commands
delete all SQLite app data. Quit Anvil first. Reset creates the schema only;
the app seeds default settings on its next startup. Project memory is untouched.

For project memory with local embeddings:

```
cp .env.example .env
docker compose up -d ollama
docker compose run --rm ollama-pull
set -a; . ./.env; set +a
npm run dev
```

## Usage

1. Add a project folder from the sidebar.
2. Start a new task, pick an agent, describe the work, and dispatch.
3. Follow execution in Output. Issues advance automatically after validation.
4. When the task finishes, open Changes to review the cumulative diff, leave
   comments, or approve.
5. Use the Terminal tab when you want to work in the project yourself.

Anvil does not manage provider credentials. Each agent uses whatever auth it
already has, so a harness that works in your terminal works here unchanged.
The model picker filters by model creator, then groups results by the provider
whose credentials are used, such as OpenCode Go, OpenCode Zen, or OpenRouter.
Search matches both model and provider names. Selecting an OpenRouter model
preserves its full `openrouter/<creator>/<model>` ID for OpenCode; it does not
switch to the creator's direct API key.

For OpenCode, the thinking selector uses each model's advertised effort names
from `opencode models --verbose`. Switching models restores that model's saved
choice if still supported, otherwise selects a supported value. Models without
advertised efforts use the agent default. Effort choices are saved per model;
OpenCode's live ACP options are checked again before starting a prompt.

Successful tasks move to Settled four hours after approval, or after completion
when there were no code changes. Running, failed, cancelled, and unreviewed
tasks stay active. Right-click a task to delete it. Deletion removes SQLite
state and cancels the agent. Valence issues, project files, and Git branches stay
put. Removing a project also stops its Anvil agents without deleting Valence data.

### OpenCode provider timeouts

OpenCode provider timeouts are configured in `~/.config/opencode/opencode.json`,
not in Anvil. Merge the following into your existing config to limit OpenRouter
requests to five minutes and abort streams with no incoming chunks for one minute:

```json
{
  "provider": {
    "openrouter": {
      "options": {
        "timeout": 300000,
        "chunkTimeout": 60000
      }
    }
  }
}
```

These limits apply to individual model requests, not shell commands or whole tasks.
The full-request timeout also bounds streams that send only keepalive comments.
OpenCode handles any retries; this does not automatically restart an Anvil task.
Restart Anvil after current tasks finish so its OpenCode server reloads the config.
Other OpenCode providers can use the same options under their own provider ID.

While an ACP or Codex app-server turn is running, Anvil publishes partial message
and thinking lines every 250 ms. Later text updates the same log row until a
newline or message/tool boundary.

## Valence integration

Anvil bundles Valence's library, CLI, and generated migrations from the vendored
tarball. Valence is a build-time dependency, not a separately installed runtime
package. Anvil uses its public library through `src/main/tasks/task-issues.ts`;
Valence owns validation, dependency graphs, claims, completion, and persistence.

Starting a new task initializes config storage at
`~/.config/valence/<project-name>/sqlite.db` only if no tracker exists.
Project-local storage is optional through `vl init --local`; existing local
trackers are still discovered and never moved automatically. Anvil always uses
the original project directory for Valence, not a temporary task worktree.
Existing storage is opened without applying Valence migrations; run `vl init`
explicitly when an upgrade is authorized. Keep `.valence/` out of Git when
opting into local storage.

At startup Anvil creates `vl` and `vl.cmd` launchers in its user-data `bin`
directory and adds it to the PATH inherited by agents and terminals. The CLI
uses Electron's Node runtime and bundled SQLite addon, so no global Valence or
Node installation is needed for `vl`. Run `vl --help` to inspect commands.

Implementation agents can complete or block their assigned issue through `vl`.
In worktrees, use `vl --project <original-project-directory> <command>` to access
the same tracker as Anvil. This optional flag selects project context, not
project-local storage. Agents should not run `init` or opt into `--local`.
Relative `--file` paths still refer to the caller's
working directory. Prompts include the project path. Codex receives write access
to the tracker directory for SQLite's database and WAL files, not the whole
source checkout.

Agents respond in plain text. Anvil never parses their responses for plans or
completion. After a successful planning turn, it reads issues labeled
`anvil-task:<task-id>` from Valence, checks the 50-issue limit and queued status,
and saves their IDs. A successful planner with no labeled issues means no work;
a failed process does not. Planners must block partial issues if they cannot
finish the plan. Failed plans stay in Valence for inspection and are not claimed.

After each implementation turn, the assigned issue must already be complete in
Valence. A success message alone cannot advance the task. Valence validates the
checklist and evidence, and Anvil leaves that evidence untouched. Separately
installed Node clients and global `vl` installations can still share storage.

Anvil claims with an explicit set of task issue IDs, never with an unrestricted
project claim. It blocks only claims owned by its current process when a turn
fails or is cancelled. On restart it marks Anvil tasks interrupted but leaves
Valence issues untouched. Inspect partial work and confirm that the old worker
has stopped before manually requeueing an issue. If another client claims task
work or dependencies leave nothing ready, Anvil stops with an error rather than
stealing work or bypassing dependencies. Interrupted tasks do not auto-resume.
