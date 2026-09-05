# Anvil

An agentic development platform. No chats, clear tasks.

Anvil is a desktop app for putting coding agents to work on a project folder.
You write a task, dispatch it, and review a diff. There is no chat window and no
persona to negotiate with — an agent here is an instrument you point at a
problem, the same as a compiler or a test runner. The terminal is still one tab
away when you want to do the work yourself.

## Philosophy

**An agent is a tool.** Agents keep being dressed up as teammates: chat threads,
personalities, a conversation you steer turn by turn. That framing quietly moves
agency from the developer to the agent, and it changes what you end up with — a
transcript to read instead of a diff to review.

Anvil takes the other position. Agency stays with you. You decide what the work
is; the agent executes it the way any other tool in your toolchain does. You
invoke it, it runs, you inspect the result. If the result is wrong you sharpen
the task and run it again, the same way you would re-run a failing build. The
agent is never in charge, and it is never asked to be.

**Clear tasks beat conversation.** A chat lets an ambiguous request survive,
because you can always clarify in the next message. A task cannot: it has to be
stated well enough to run unattended. That constraint is the feature. Writing
the task *is* the engineering, and it stays with the developer.

**The agent works the way you would.** It gets a worktree, a branch, and your
task. It uses Git normally and writes its own commit messages. Anvil asks it to
plan small issues and validate each one. It works through them sequentially,
then presents the whole task result and local diff for your review.

**Nothing is hidden.** The run log shows the agent's own output — its thinking,
its tool calls, its errors — and every Git command Anvil runs on your behalf.
Anvil steps in for exactly one thing: not losing work. If an agent finishes
without committing, Anvil commits the remainder so the branch survives, and says
so plainly in the log.

## Scope

Anvil is a local development tool, not infrastructure. It runs agent CLIs as
child processes against checkouts on your own machine — no cluster, no control
plane, no fleet to operate. Fleet-scale agent orchestration is a real and
different problem; this is not that. Anvil is for one developer and the projects
on their disk.

## Requirements

- Node 20+
- At least one agent CLI on your PATH (`opencode` is the default), already
  authenticated with its own provider credentials

## Development

```
npm install
npm run dev
```

After changing `src/main/db/schema.ts`, run `npm run db:generate` to write the
matching migration and commit it alongside the schema change.

If your shell exports `ELECTRON_RUN_AS_NODE=1`, unset it first or Electron will
boot as plain Node and fail to open a window.

### Project memory

SQLite stores app settings, projects, runs, issue trackers, comments, and logs. Project memory
uses the `ProjectMemory` interface with two adapters:

- PGlite is the desktop default. It runs PostgreSQL and pgvector inside Anvil and
  persists under `~/.anvil-composer/memory/pglite`.
- PostgreSQL supports self-hosted installations and a future managed backend.
  Select it with `ANVIL_MEMORY_BACKEND=postgres` and
  `ANVIL_MEMORY_DATABASE_URL`.

Both adapters store memory derived from successful tasks. Each record contains
the task, agent result, commit subjects, and a bounded patch excerpt. New tasks
receive up to three related memories with a cosine similarity above 0.5.

Ollama generates embeddings locally. For desktop development, start Ollama and
run the app on the host:

```
cp .env.example .env
docker compose up -d ollama
docker compose run --rm ollama-pull
set -a; . ./.env; set +a
npm run dev
```

Run `docker compose up app` to test the self-hosted PostgreSQL adapter. Compose
applies its Drizzle migrations, starts Ollama, downloads `mxbai-embed-large`,
and runs Electron under Xvfb. The container has no interactive desktop window.

`src/main/memory/schema.ts` declares the schema shared by PGlite and PostgreSQL.
After changing it, run `npm run memory:generate` and commit the generated
migration. The vector column has 1024 dimensions, matching
`mxbai-embed-large`.

Quit Anvil before inspecting its PGlite database, then run:

```
npm run memory:inspect
npm run memory:inspect -- --project <project-id> --limit 50
npm run memory:inspect -- --json
```

The inspector follows `ANVIL_MEMORY_BACKEND`. Set the PostgreSQL environment
variables first when inspecting the self-hosted backend.

## Build an executable

```
npm run pack    # unpacked app in release/win-unpacked
npm run dist    # NSIS installer in release/
```

## Usage

1. Add a project folder from the sidebar.
2. The project overview shows current work, tasks ready for review, and monthly
   usage against the limits set for that project.
3. Hit **Start new task**, pick an agent, describe the work, and dispatch.
   The agent organizes the task into up to 50 internal issues.
4. Open **Output** to follow execution. Issues advance automatically after
   validation, with no per-issue review or approval.
5. When the task finishes, open **Changes** to review the cumulative local diff,
   leave comments, or approve the task.
6. Open the Terminal tab when you need to work in the project directly.

Anvil does not manage provider credentials. Each agent uses whatever auth it is
already configured with (for example `opencode auth login`), so a harness that
works in your terminal works here unchanged.

### Agent issue tracker

The issue tracker is internal to agents. There is no Board UI or per-issue
approval. SQLite stores its state in `task_issue_trackers`, including stable
issue hashes, descriptions, checklists, validation evidence, labels, priorities,
dependency hashes, and status. No issue files are written to the repository.

The agent chooses up to 50 atomic issues. Planning uses unique temporary keys
for dependencies; Anvil resolves them to hashes and rejects missing references,
self-dependencies, and cycles. Priorities are `urgent`, `high`, `medium`, and
`low`. Status progresses from `queued` to `working` to `complete`; failed or
interrupted work becomes `blocked`.

Anvil runs one issue at a time. All dependencies must be complete before an
issue can start. Ready issues are selected by priority, then plan order. Agents
are instructed not to delegate. Validation evidence is agent-reported, not an
independent sandbox or verification service.

Agent final messages use one `<anvil-issue-tracker>` JSON block. Planning returns
`items` with `key`, `title`, `description`, `labels`, `priority`,
`dependencies`, `status: "queued"`, `checklist`, and `validation`.
Completion returns the current `id`, `status: "complete"`, a true value for
each checklist entry, and nonempty `evidence`.

Issues share one task worktree. Only after all issues complete does Anvil
finalize Git delivery and offer the cumulative diff for user review. Invalid
results or failed processes stop execution. Restarting preserves issue state
and blocks interrupted work without automatically resuming it.

Run `npm run test:issue-tracker` for backend scheduling, metadata validation,
persistence, failure handling, and real Git delivery tests.

## Adding an agent

Agents are just processes that write to stdout. Add one entry to
`src/main/agents/registry.ts`:

```ts
{
  id: 'my-agent',
  label: 'My Agent',
  description: 'What it does.',
  command: 'my-agent',
  args: ['run', '--model', '{{model}}', '{{prompt}}'],
  defaultModel: 'openrouter/some/model'
}
```

`{{prompt}}` and `{{model}}` are substituted per run. A `{{model}}` token and
the flag before it are dropped when no model is set.

Only `opencode` is verified end to end. The `claude`, `codex`, and `pi` entries
use their documented non-interactive invocations; if one is wrong, it is a
one-line fix in the registry.

## Notes

- Agents run with stdin closed so they cannot block on an interactive prompt.
  `opencode` is dispatched with `--auto`; without it a headless run waits
  forever on the first permission request.
- On Windows, npm installs CLIs as `.cmd` shims. Anvil reads the shim and spawns
  the real executable directly, so prompts containing quotes, `&`, or `%` are
  passed through untouched instead of being mangled by a shell.
- Projects, settings, runs, comments, and run output are stored in
  `~/.anvil-composer/anvil.db`, through [Drizzle](https://orm.drizzle.team/)
  on `better-sqlite3`. Completed-task memory uses embedded PGlite by default or
  PostgreSQL when `ANVIL_MEMORY_BACKEND=postgres`. Ollama generates embeddings
  locally through `ANVIL_OLLAMA_BASE_URL`.
  `src/main/db/schema.ts` is the single declaration of the SQLite
  schema; `npm run db:generate` diffs it and writes the next numbered migration
  into `src/main/db/migrations`, and the app applies whatever is outstanding
  when it opens the database. Never edit or rename a generated migration — the
  journal records what has already been applied. `npm run db:drop` deletes the
  database and `npm run db:reset` recreates it from the migrations.
- A task in a Git repository gets an isolated worktree and a branch from the
  repository's current checkout, named `<task>-<id>` as a starting point. If the
  repository has no commits yet, Anvil creates the initial commit first (from
  the current non-ignored files, or an empty commit when the folder is empty).
- Agents are asked to use Git themselves. Every task in a repository is prefixed
  with a short instruction: commit your own changes with a clear message, prefix
  the subject with `fix:`, `feat:`, `chore:`, or `docs:` where the category is
  clear, rename the branch when a clearer name fits, and do not push. The commit
  message and the final branch name are the agent's own — Anvil never generates
  a message from the task title or rewrites what the agent wrote, and it records
  whichever branch the worktree ends on. Commits use your configured Git
  identity, not a bot identity.
- If an agent finishes with uncommitted changes anyway, Anvil records a
  `did_not_commit` event, shows the `git add` and `git commit` it runs, and
  commits the remainder under the task title before removing the worktree. This
  is a safety net, not the intended path.
- A project without a Git repository still works. The overview shows a notice
  with a button to run `git init`, and until then agents run directly in the
  project folder with branches, worktrees, and diffs skipped.
- **Approve** in the review bar accepts the work: the task moves out of **Ready
  for review** into **Completed** and stops offering Send, Squash and new
  comments. The diff stays readable. Nothing is pushed or merged — approval is
  a state, not yet an action.
- **Rebase** above the commit list rewrites the task's commits, in one of two
  modes set in Settings.
  - *Manual* (the default) opens a small interactive rebase: each commit gets
    `pick`, `squash` or `drop`, and a `pick`'s message is editable. Anvil
    performs the rebase itself by resetting to the branch point and replaying
    the kept commits, so the result is exactly the plan and no agent is
    involved. If anything fails the branch is restored to where it was, and a
    plan built from a stale commit list is refused rather than applied.
  - *Agent* hands the branch to the agent that wrote the code and accepts its
    result, confirming first unless you tick "don't ask again".
  Neither mode touches anything at or before the branch point. Neither checks
  for a remote: rebasing rewrites the branch, so it is on you to know whether
  anyone else has it.
- Review notes are line comments on a task's diff, the way a pull request works.
  They are held as drafts — visible in the diff, removable — until **Send**.
  Sending re-opens a worktree on the task's branch, resumes the agent's original
  session where the CLI supports it (`opencode -s`, `claude --resume`) so the
  context of the work is not lost, and runs it again against the notes. When
  the CLI cannot resume, the follow-up runs as a fresh session in the same
  worktree. The task keeps its original base commit, so the diff you review
  afterwards covers the whole task, first pass and follow-ups together.
- Agent success and code readiness are separate. Exit code `0` means the task
  succeeded. Code is ready for review only when that successful branch has a
  non-empty diff from its starting commit.
- Local diffs are rendered with [`@pierre/diffs`](https://diffs.com/). The
  **Work is done on push** project setting is persisted, but remote push and
  GitHub pull-request creation are intentionally not implemented yet.
- Each task records elapsed time and any token usage and cost reported by its
  agent CLI.
- Running agents are killed when the app quits; a run cannot survive a restart.

## Layout

```
src/main/db/schema.ts         Drizzle table definitions (the schema)
src/main/db/migrations/       generated migrations, applied at startup
src/main/agents/registry.ts   agent definitions
src/main/agents/resolve.ts    PATH + Windows shim resolution
src/main/agents/runner.ts     spawn, stream stdout/stderr, cancel
src/main/git-delivery.ts      task worktrees, branches, commits, local diffs
src/main/terminal.ts          PTY sessions
src/main/store.ts             SQLite-backed projects, runs, events, settings
src/main/ipc.ts               IPC surface
src/renderer/                 React UI
```
