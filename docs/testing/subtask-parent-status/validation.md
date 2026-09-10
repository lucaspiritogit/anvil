# Parent subtask status validation

Issue: `9e5465dccf90b844`

The sidebar, task header and output activity derive their presentation from the same issue snapshot. Review takes precedence over a still-running task. Persisted execution metadata identifies the current issue and interrupted/blocked execution. Task delivery status and final approval eligibility are unchanged. The existing scheduler's stopped-turn guard also supplies renderer review readiness. Explicit cache refreshes invalidate older in-flight reads; periodic polls coalesce without starving slow reads.

This issue covers status presentation. Parent issue-diff/review controls and removal of child navigation belong to the subsequent issues in the supplied plan.

## Commands and actual results

- `npm ci`: passed; installed local dependencies and rebuilt Electron SQLite. Reported four moderate dependency audit findings.
- `npm run typecheck`: passed.
- `npm run typecheck:tests`: passed after adding the missing `validation` field to a new test fixture; rerun passed after final test edits.
- `npm test -- tests/issue-tracker.test.ts tests/issue-tools.test.ts tests/task-recovery.test.ts tests/task-issues-refresh.test.ts`: final run passed, four files, 23 tests passed and one existing live Codex test skipped because `ANVIL_LIVE_CODEX_HOME` was unset. Initial run failed on a new test's assumption that execution phase had already changed at direct tool submission; the assertion now checks child review and the stopped-turn gate independently of that timing.
- `npx playwright install chromium`: passed after the first browser run reported a missing Chromium executable.
- `npm run test:e2e -- tests/e2e/subtask-lifecycle.spec.ts tests/e2e/task-issues-refresh.spec.ts`: final run passed, four tests. An earlier run caught an incorrectly completed task fixture in the new transition test; the fixture now explicitly starts running. The final run includes submission before turn stop and the later ready state.
- `git diff --check`: passed.

## Visual inspection

Manually inspected the generated browser screenshots for queued/rework, working, stopping for review, ready for review, blocked, recovered working, and subtask complete, with Issues closed and subtask rows collapsed. The parent header and sidebar show the same current subtask and state; Review removes the Working spinner. Output stays on the parent. Intermediate completion shows "Subtask complete" and does not expose final approval. Inspected the 900px-wide completion capture as well as the 1280px-wide captures.

Screenshots are the adjacent `parent-*.png` files. The automated scenario drives review -> queued -> working (rework), blocked -> working (recovery), and review -> complete (approval outcome). Backend tests exercise actual approval/rework, dependency/priority scheduling, malformed turn output, persisted recovery and final delivery.

Live Electron interaction was not performed: `orca skills get computer-use` failed with "The term 'orca' is not recognized as a name of a cmdlet, function, script file, or executable program." Visual inspection used browser fixture captures; it does not constitute a live-agent desktop test.
