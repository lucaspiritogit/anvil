# Repository Guidelines

## Project structure

Anvil is an Electron desktop app built with TypeScript, React, Zustand, and Tailwind CSS.

- `src/main/` owns agent processes, the issue tracker, Git worktrees, SQLite storage, and IPC handlers.
- `src/main/db/` contains the Drizzle SQLite schema and generated migrations. `src/main/memory/` contains the separate PGlite/PostgreSQL project-memory adapters and migrations.
- `src/preload/index.ts` exposes the typed desktop API; `src/shared/` holds shared types and keybindings.
- `src/renderer/src/` contains React components, application state, styles, and shared UI helpers.
- `tests/` contains issue tracker tests and test doubles. `scripts/` contains maintenance and test runners. `public/` holds static assets.

## Development commands

- `npm ci`: install locked dependencies locally and rebuild native Electron modules. Use `npm install` when changing dependencies.
- `npm run dev`: start Electron with Vite development tooling. Unset `ELECTRON_RUN_AS_NODE` first.
- `npm run typecheck`: check main-process and renderer TypeScript.
- `npm test`: run Vitest once. `npm run test:issue-tracker -- <suite>` is a compatibility alias with Vitest filename filters.
- `npm run typecheck:tests`: strictly check migrated tests and the Vitest configuration.
- `npm run build`: typecheck and generate production bundles in `out/`.
- `npm run pack` / `npm run dist`: build unpacked Windows output or an installer.
- `npm run pack:mac` / `npm run dist:mac`: build a local unsigned macOS app or DMG in `release/` for the current architecture.
- `npm run db:generate` / `npm run memory:generate`: generate migrations after changing the corresponding schema. Include generated SQL, snapshots, and journal changes together; do not hand-edit generated migrations.

## Coding style

Use two-space indentation, single quotes, and no semicolons. Keep TypeScript strict and use explicit types at IPC boundaries. Name React components in PascalCase, functions and variables in camelCase, and utility modules in kebab-case. Reuse `ui.ts` helpers and existing Tailwind classes. No formatter or lint command is configured; follow nearby code and run typecheck.

## Testing

Tests use Vitest on host Node ^22.12.0, ^24.0.0, or >=26.0.0. Name suites `tests/*.test.ts`; discovery is automatic and excludes Playwright under `tests/e2e/`. Use named `test`/`describe` cases, `expect`, and `vi`. `tsconfig.test.json` automatically checks test suites and helpers, excluding Playwright. Use `npm test -- tests/task-usage.test.ts` for one exact file or `npm run test:issue-tracker -- task-usage` for a filename filter. Run browser coverage separately with `npm run test:e2e`. The npm test commands build a private host SQLite addon without changing Electron's installed addon. Register resource disposal with `onTestCleanup` and use `registerTestIpc` for IPC fixtures. See `docs/testing/vitest-migration.md` for runtime details, the migration audit and validation evidence. No coverage threshold is configured. Cover dependency and priority scheduling, sequential execution, malformed output, restart persistence, and final task diffs when changing the issue tracker. Use temporary databases and repositories. Include manual UI checks for renderer changes.

## Commits and pull requests

Git history is small and has no consistent message convention. Prefer the prefixes documented in agent Git instructions: `feat:`, `fix:`, `chore:`, or `docs:`. Keep changes focused. PR descriptions should explain behavior, reference relevant issues, report checks performed, and include screenshots for visible UI changes.

## Configuration

Use `.env.example` for local configuration; never commit `.env` or credentials. App data lives under `~/.anvil-composer/`. Database drop/reset commands delete local data. Keep the issue tracker agent-only and present one final task diff for user review. Plans have no issue-count limit.
