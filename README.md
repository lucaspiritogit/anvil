# Anvil

Coding agents as infrastructure, not conversation.

Anvil is a small Electron desktop app for dispatching coding agents at project
folders and watching them work. Agents are background workloads you start,
observe, and review from the project overview. The terminal remains available
when you need it, but it is not the home screen.

## Requirements

- Node 20+
- At least one agent CLI on your PATH (`opencode` is the default), already
  authenticated with its own provider credentials

## Development

```
npm install
npm run dev
```

If your shell exports `ELECTRON_RUN_AS_NODE=1`, unset it first or Electron will
boot as plain Node and fail to open a window.

## Build an executable

```
npm run pack    # unpacked app in release/win-unpacked
npm run dist    # NSIS installer in release/
```

## Usage

1. Add a project folder from the sidebar.
2. The project overview shows current work, tasks ready for review, and monthly
   usage against the limits set for that project.
3. Hit **Start new task**, pick an agent, describe the work, and dispatch. The
   run view streams the agent's output live.
4. A successful task with code changes appears under **Ready for review**. Open
   it to inspect its commits and local diff.
5. Open the Terminal tab when you need to work in the project directly.

Anvil does not manage provider credentials. Each agent uses whatever auth it is
already configured with (for example `opencode auth login`), so a harness that
works in your terminal works here unchanged.

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
- Projects, settings, runs, and run output are stored in
  `~/.anvil-composer/anvil.db`.
- A task requires a Git repository. If it has no commits yet, Anvil creates the
  initial commit from its current non-ignored files (or an empty commit when the
  folder is empty). It then creates an isolated worktree and an
  `anvil/<task>-<id>` branch from the repository's current checkout. Agents do
  not need to commit. If they leave changes in the worktree, Anvil records a
  `did_not_commit` event and creates the delivery commit before removing the
  worktree.
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
src/main/agents/registry.ts   agent definitions
src/main/agents/resolve.ts    PATH + Windows shim resolution
src/main/agents/runner.ts     spawn, stream stdout/stderr, cancel
src/main/git-delivery.ts      task worktrees, branches, commits, local diffs
src/main/terminal.ts          PTY sessions
src/main/store.ts             SQLite-backed projects, runs, events, settings
src/main/ipc.ts               IPC surface
src/renderer/                 React UI
```
