# Repository Guidelines

## Project structure

Anvil is an Electron desktop app and standalone Node server built with TypeScript, React, Zustand, and Tailwind CSS.

- `apps/server/src/` owns agent processes, the issue tracker, Git worktrees, SQLite storage, and HTTP handlers.
- `apps/server/src/db/` contains the Drizzle SQLite schema and generated migrations. `apps/server/src/memory/` contains the separate PGlite/PostgreSQL project-memory adapters and migrations.
- `apps/desktop/src/` owns Electron main and preload code.
- `apps/web/src/` contains the browser UI used by the standalone server and Electron.
- `packages/protocol/`, `packages/client-api/`, and `packages/app-data/` contain shared contracts and host-neutral helpers.
- `tests/` contains issue tracker tests and test doubles. `scripts/` contains maintenance and test runners. `public/` holds static assets.

## Development commands

- `npm ci`: install locked dependencies locally and rebuild native Electron modules. Use `npm install` when changing dependencies.
- `npm run dev`: start Electron with Vite development tooling. Unset `ELECTRON_RUN_AS_NODE` first.
- `npm run typecheck`: check main-process and renderer TypeScript.
- `npm run build`: typecheck and generate production bundles in `out/`.
- `npm run pack` / `npm run dist`: build unpacked Windows output or an installer.
- `npm run pack:mac` / `npm run dist:mac`: build a local unsigned macOS app or DMG in `release/` for the current architecture.
- `npm run db:generate` / `npm run memory:generate`: generate migrations after changing the corresponding schema. Include generated SQL, snapshots, and journal changes together; do not hand-edit generated migrations.

## Testing

Run `npm run typecheck` to verify that the code works, only run unit or integration tests focused on the task to verify behavior, do not run the full suite of tests unless explicitly told so.

## Coding guidelines

Do not add comments to the code, unless explicitly told so

## Commits and pull requests

Git history is small and has no consistent message convention. Prefer the prefixes documented in agent Git instructions: `feat:`, `fix:`, `chore:`, or `docs:`. Keep changes focused. PR descriptions should explain behavior, reference relevant issues, report checks performed, and include screenshots for visible UI changes.

## Configuration

Use `.env.example` for local configuration; never commit `.env` or credentials. App data lives under `~/.anvil-composer/`. Database drop/reset commands delete local data. Keep the issue tracker agent-only and present one final task diff for user review. Plans have no issue-count limit.
