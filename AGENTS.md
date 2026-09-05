# Repository Guidelines

## Project structure

Anvil is an Electron desktop app built with TypeScript, React, Zustand, and Tailwind CSS.

- `src/main/` owns agent processes, the issue tracker, Git worktrees, SQLite storage, and IPC handlers.
- `src/main/db/` contains the Drizzle SQLite schema and generated migrations. `src/main/memory/` contains the separate PGlite/PostgreSQL project-memory adapters and migrations.
- `src/preload/index.ts` exposes the typed desktop API; `src/shared/` holds shared types and keybindings.
- `src/renderer/src/` contains React components, application state, styles, and shared UI helpers.
- `tests/` contains issue tracker tests and test doubles. `scripts/` contains maintenance and test runners. `public/` holds static assets.

## Development commands

- `npm install`: install dependencies and rebuild native Electron modules.
- `npm run dev`: start Electron with Vite development tooling. Unset `ELECTRON_RUN_AS_NODE` first.
- `npm run typecheck`: check main-process and renderer TypeScript.
- `npm run test:issue-tracker`: run issue tracker lifecycle and real Git integration tests.
- `npm run build`: typecheck and generate production bundles in `out/`.
- `npm run pack` / `npm run dist`: build unpacked Windows output or an installer.
- `npm run db:generate` / `npm run memory:generate`: generate migrations after changing the corresponding schema. Include generated SQL, snapshots, and journal changes together; do not hand-edit generated migrations.

## Coding style

Use two-space indentation, single quotes, and no semicolons. Keep TypeScript strict and use explicit types at IPC boundaries. Name React components in PascalCase, functions and variables in camelCase, and utility modules in kebab-case. Reuse `ui.ts` helpers and existing Tailwind classes. No formatter or lint command is configured; follow nearby code and run typecheck.

## Testing

Tests use `node:assert/strict`, bundled through esbuild and executed with Electron's Node runtime. Name suites `tests/*.test.ts` and register new suites in `scripts/test-issue-tracker.mjs`. No coverage threshold is configured. Cover dependency and priority scheduling, sequential execution, malformed output, restart persistence, and final task diffs when changing the issue tracker. Use temporary databases and repositories. Include manual UI checks for renderer changes.

## Commits and pull requests

Git history is small and has no consistent message convention. Prefer the prefixes documented in agent Git instructions: `feat:`, `fix:`, `chore:`, or `docs:`. Keep changes focused. PR descriptions should explain behavior, reference relevant issues, report checks performed, and include screenshots for visible UI changes.

## Configuration

Use `.env.example` for local configuration; never commit `.env` or credentials. App data lives under `~/.anvil-composer/`. Database drop/reset commands delete local data. Keep the issue tracker agent-only, allow up to 50 issues, and present one final task diff for user review.
