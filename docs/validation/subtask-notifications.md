# Subtask notification validation — 2026-09-10

Issue: `f209ad6891e9b61d`.

## Implementation

Store activity now observes execution metadata and issue-tool/scheduler writes after
an outer SQLite transaction commits. Read-only transactions do not emit activity;
rollback does not advance the notification baseline. Listener exceptions are isolated.
The observer tracks each workspace/task/issue, includes the issue title and ID with
its owning task title, and emits review and blocked transitions while the task runs.
Startup, workspace changes, metadata writes, deletion and listener re-registration do
not replay alerts. Rework followed by review produces another alert.

Scheduler cancellation commits the cancelled task and blocked issue together. This
produces one cancelled subtask alert, including when the agent submitted review but
has not exited yet. Ordinary failures produce blocked alerts, without a duplicate
parent pause. Unrelated top-level lifecycle notifications remain enabled. Task and
project deletion group their stop and removal writes to suppress incidental alerts.
The prerequisite's authorization/delivery service is reused without modification.

## Automated results

All commands ran directly with visible output using the existing local node_modules
directory (not a symlink). No branch changes or pushes were made. The test runner's
`user-current` branch message comes from its temporary Git fixture.

Final validation:

```sh
npm test -- tests/task-notifications.test.ts tests/task-issues-refresh.test.ts tests/issue-tools.test.ts tests/issue-tracker.test.ts tests/issue-tracker-git.test.ts tests/task-recovery.test.ts tests/task-auto-recovery.test.ts tests/notification-delivery.test.ts tests/caffeine-mode.test.ts tests/task-deletion.test.ts tests/workspace-store.test.ts tests/workspace-ipc.test.ts tests/ipc-handlers.test.ts tests/valence-integration.test.ts tests/task-steering.test.ts
npm run typecheck
npm run typecheck:tests
```

- Tests: exit 0, 15 files / 99 tests.
- Both typechecks: exit 0.
- `git diff --check`: exit 0 before commit.

Coverage includes real issue-tool review/block/requeue paths, scheduler cancellation
while working, immediately after submission and while reviewing, permanent failure,
first-use grant/denial, rollback, disposal, background workspace, repeated review,
listener failure and existing scheduling, Git review, restart and recovery behavior.

Earlier runs: the initial eight-suite run passed 37 tests; added scheduler tests
passed 14 tests; expanded notification tests passed 9 tests. The first expanded
seven-suite run failed 2 of 56 tests: tracker-close assertions included the new
notification observer reads, and the IPC channel expectation omitted the existing
`wallpapers:import` handler. Close assertions now measure each snapshot read, and
the channel expectation includes that handler, retaining sender validation for it.
The final combined run above passed after these corrections and read-only activity
suppression.

## Native macOS results and remaining blocker

- `npm run pack:mac`: exit 1. Native bridge compilation, both application typechecks
  and production bundling succeeded. Packaging failed because no valid Developer ID
  Application or custom signing identity is installed. This attempt preceded the
  final read-only transaction activity suppression; final source passed typechecks
  and the combined suite above.
- `security find-identity -v -p codesigning`: exit 0, zero valid identities.
- `codesign --verify --deep --strict --verbose=2 release/mac-arm64/Anvil.app`:
  exit 1, “code has no resources but signature indicates they must be present”.
- `node scripts/probe-mac-notifications.cjs release/mac-arm64/Anvil.app/Contents/MacOS/Anvil --request`:
  exit 1. The actual packaged executable reported authorization `not-determined`,
  then the native request failed with `UNErrorDomain error 1`. It used temporary app
  data and did not reset system preferences. An existing closing-window `ERR_FAILED`
  was also logged during shutdown. No successful delivery is claimed.

A properly signed app with granted notification permission is still required to
manually verify visible review, blocked, working-cancel and reviewing-cancel banners;
exactly one correctly titled alert per event; background/minimized delivery; repeated
review after rework; and no replay after restart. These checks were not completed.
There are no renderer changes. Automated notification mocks are not native-delivery
proof. The issue must remain blocked rather than confirming its last checklist item.

Anvil rejected an attempted description update with “Issues can only be edited
during planning”; this issue was already claimed/working. No ownership, dependencies,
or other issues were changed.
