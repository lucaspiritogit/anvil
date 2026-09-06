# Anvil

An agentic development platform. No chats, clear tasks.

Anvil is a desktop app for putting coding agents to work on a project folder.
You write a task, dispatch it, and review a diff. There is no chat window and no
persona to negotiate with. An agent here is an instrument you point at a
problem, the same as a compiler or a test runner. The terminal is still one tab
away when you want to do the work yourself.

## Philosophy

**An agent is a tool.** Agents keep being dressed up as teammates: chat threads,
personalities, a conversation you steer turn by turn. That framing quietly moves
agency from the developer to the agent, and it changes what you end up with. You
get a transcript to read instead of a diff to review.

Anvil takes the other position. Agency stays with you. You decide what the work
is. The agent executes it the way any other tool in your toolchain does. You
invoke it, it runs, you inspect the result. If the result is wrong you sharpen
the task and run it again, the same way you would re-run a failing build. The
agent is never in charge, and it is never asked to be.

**Clear tasks beat conversation.** A chat lets an ambiguous request survive,
because you can always clarify in the next message. A task cannot. It has to be
stated well enough to run unattended. That constraint is the feature. Writing
the task *is* the engineering, and it stays with the developer.

**The agent works the way you would.** It gets a worktree, a branch, and your
task. It uses Git normally and writes its own commit messages. Anvil asks it to
plan small issues and validate each one. It works through them sequentially,
then presents the whole task result and local diff for your review.

**Nothing is hidden.** The task log shows the agent's own output, its thinking,
its tool calls, its errors, and every Git command Anvil runs on your behalf.
Anvil steps in for exactly one thing: not losing work. If an agent finishes
without committing, Anvil commits the remainder so the branch survives, and says
so plainly in the log.

## Architecture

Anvil is an Electron app. The main process owns the real work. The renderer is a
React UI that talks to it through a typed preload bridge.

```
┌─────────────┐  IPC  ┌──────────────┐  contextBridge  ┌────────────┐
│  main       │◄─────►│  preload     │◄───────────────►│  renderer  │
│  Node/Electron      │  typed API   │                 │  React UI  │
└─────────────┘       └──────────────┘                 └────────────┘
```

**Main process** (`src/main/`) runs agents, Git worktrees, SQLite storage, the
issue tracker, project memory, and PTY terminals. `ipc.ts` creates shared
dependencies and registers the handlers in `ipc/`. `tasks/` owns issue execution,
completion, and agent event persistence. Shared types live in `src/shared/`.

**Preload** (`src/preload/`) exposes a narrow `window.api` surface. The renderer
never gets Node or raw IPC channels.

**Renderer** (`src/renderer/`) is React plus Zustand. Sidebar, project overview,
task view, diff review, settings, and the terminal pane all call into that API.

A typical task flows like this:

1. You describe work and pick an agent. Main creates a task in SQLite.
2. For Git projects, `GitDeliveryManager` creates an isolated worktree and branch.
3. `AgentProcessManager` routes OpenCode through ACP, Codex through its app-server
   adapter, and Pi through its CLI runner. All produce task events for persistence.
4. The agent plans up to 50 internal issues. Anvil runs them one at a time by
   priority and dependencies, with no Board UI and no per-issue approval.
5. When everything finishes, Anvil finalizes Git delivery and shows one
   cumulative local diff for review. Approve, comment, rebase, or settle from
   there.

**Storage.** App state lives in `~/.anvil-composer/anvil.db` via Drizzle on
better-sqlite3: projects, tasks, events, comments, settings, and issue trackers.
Completed-task memory is separate. PGlite with pgvector is the desktop default.
PostgreSQL is available for self-hosted setups. Ollama generates embeddings
locally. Schema sources are `src/main/db/schema.ts` and
`src/main/memory/schema.ts`. Generate migrations with `npm run db:generate` and
`npm run memory:generate`. Do not hand-edit generated migrations.

```
src/main/                 agents, Git, SQLite, IPC, memory, terminals
src/main/db/              SQLite schema and migrations
src/main/ipc/             handlers for projects, tasks, review, rebase, and terminals
src/main/tasks/           issue execution, task completion, and agent events
src/main/memory/          PGlite / PostgreSQL project memory
src/preload/              typed desktop API
src/shared/               types and keybindings
src/renderer/             React UI
tests/                    issue tracker and e2e suites
```

## Requirements

- Node 20+
- At least one agent CLI on your PATH. `opencode` is the default. Authenticate
  it with its own provider credentials beforehand.

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

`docker compose up app` exercises the PostgreSQL memory adapter under Xvfb.
Set `ANVIL_MEMORY_BACKEND=postgres` and `ANVIL_MEMORY_DATABASE_URL` for that
path. PostgreSQL needs pgvector enabled before migrations; Compose installs
it when initializing a database. Quit Anvil before `npm run memory:inspect`.

```
npm run pack    # unpacked app in release/win-unpacked
npm run dist    # NSIS installer in release/
npm run test:issue-tracker
npm run test:e2e
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

Successful tasks move to Settled four hours after approval, or after completion
when there were no code changes. Running, failed, cancelled, and unreviewed
tasks stay active. Right-click a task to delete it. Deletion removes SQLite
state and cancels the agent. Project files and Git branches stay put.

## Adding an agent

For a CLI agent, add an entry to `src/main/agents/registry.ts`:

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

Pi keeps its non-interactive CLI invocation.

### Task adapter interface

`src/main/agents/agent-executor.ts` defines `AgentExecutor` and the shared task types.
ACP and Codex app-server adapters both implement:

```ts
execute(input: TaskInput, onEvent: (event: TaskEvent) => void): Promise<TaskResult>
```

- `TaskInput` carries the task and optional issue ID, prompt, absolute working
  directory, model, optional session to resume, and cancellation signal.
- `TaskEvent` carries normalized output, session IDs, or usage. Output reuses
  Anvil's persisted event format; the adapter does not access SQLite or IPC.
- `TaskResult` contains the terminal status, this turn's assistant text, session,
  optional usage, agent-reported changed files, and any error. The issue tracker
  validates its existing JSON block from that text. Git still computes the final
  task diff, including changes made through shell commands that a server may not report.

### OpenCode ACP

OpenCode runs as `opencode acp`, an ACP server subprocess speaking newline-delimited
JSON-RPC over stdin and stdout. Anvil starts one server per execution and closes it
after the prompt completes. OpenCode persists sessions so review follow-ups can
load their earlier context. Authenticate with OpenCode before running tasks.

`AgentClientProtocol` in `agent-client-protocol.ts` extends `AgentExecutor` for
ACP adapters and re-exports the shared task types for existing callers.

`OpenCodeAcpClient` initializes ACP, creates or loads a session, selects the model
through `session/set_config_option`, and sends `session/prompt`. It suppresses
replayed history, buffers streamed text into output lines, and normalizes tool
updates. Cancellation sends `session/cancel`, then terminates an unresponsive
server. Only `end_turn` is successful; refusal and limit stops fail the execution.

Usage is optional. Context occupancy is not counted as token consumption.
OpenCode reports cumulative session cost, so resumed turns leave cost unknown
rather than charging earlier work again. No filesystem or terminal capabilities
are advertised; OpenCode executes its own tools.

Run the protocol fixture tests with `npm run test:issue-tracker -- opencode-acp`.
These require no provider credentials or model calls.

### Codex app-server

`CodexAppServerClient` runs `codex app-server --listen stdio://` once per execution.
It uses Codex's own JSONL protocol, not ACP. `codex-app-server-protocol.ts` defines
Anvil's typed request subset, checked against `codex-cli 0.153.3` schema output and
[OpenAI's app-server documentation](https://learn.chatgpt.com/docs/app-server).

The adapter sends `initialize`, `initialized`, `thread/start` or `thread/resume`,
then `turn/start`. Acknowledging `turn/start` does not finish the task: the adapter
waits for `turn/completed`. Anvil persists the thread ID as its session resume
handle, since Codex's separate `thread.sessionId` can be shared across forks.

Events are scoped to the current thread and turn. Final item snapshots reconcile
streamed deltas without duplicating output. The assembled assistant text feeds
issue-tracker validation. File-change items report paths; Git remains responsible
for the final task diff. Cancellation uses `turn/interrupt`, then kills the server
and its tools if they do not stop.

Tasks use `approvalPolicy: never` and the `workspaceWrite` sandbox. Unexpected
approval requests are declined without granting persistent permissions or sandbox
escapes. This can block network access or protected Git writes. Anvil does not
answer user questions or MCP elicitation prompts on the user's behalf.
Authenticate separately with `codex login`; no credential-management or experimental
protocol capabilities are enabled by this adapter.

Token usage is thread-cumulative. New threads report execution totals. Resumed
threads subtract a pre-turn usage baseline when Codex supplies one; otherwise usage
stays unknown to avoid charging old turns again. `last` is one model request, not
an entire turn, and is not used as a turn total. Codex does not supply dollar costs
here. Model selection uses app-server, but the picker still uses a static list;
`model/list` discovery is not yet wired in.

Run `npm run test:issue-tracker -- codex-app-server` for credential-free protocol
fixture tests. OpenAI currently labels app-server experimental; this integration
uses its stable protocol subset over local stdio, not the remote transports.

## Notes

- CLI agents run with stdin closed. OpenCode uses stdin for ACP. Anvil approves
  its `allow_once` permission option automatically, matching the non-interactive
  task policy. Requests without that option are cancelled; persistent permission
  grants are never selected.
- On Windows, Anvil unwraps npm `.cmd` shims and spawns the real executable so
  prompts with quotes or shell metacharacters pass through intact.
- A Git task gets an isolated worktree and a branch named `<task>-<id>`. Agents
  commit with your Git identity, using `fix:`, `feat:`, `chore:`, or `docs:`
  prefixes when the category is clear. Anvil never invents the commit message or
  rewrites what the agent wrote. If the agent leaves uncommitted changes, Anvil
  commits the remainder under the task title as a safety net and logs it.
- Projects without Git still run. Agents work in the project folder until you
  initialize a repository. Branches, worktrees, and diffs are skipped until then.
- Approve marks the task completed. It does not push or merge.
- Rebase has two modes in Settings. Manual lets you pick, squash, or drop
  commits and Anvil replays the plan itself. Agent hands the branch back to the
  agent that wrote the code. Neither mode touches anything at or before the
  branch point.
- Review comments are line notes on the task diff. Sending them re-opens the
  worktree and resumes the agent session when the CLI supports it, otherwise
  starts a fresh session in the same worktree. The diff always covers the whole
  task from the original base commit.
- CLI exit code 0, ACP `end_turn`, or Codex turn status `completed` means execution
  succeeded. Code is ready for review only when the branch has a non-empty diff
  from its starting commit.
- Local diffs use [`@pierre/diffs`](https://diffs.com/). Remote push and GitHub
  PR creation are not implemented yet.
- Running agents are killed when the app quits.
