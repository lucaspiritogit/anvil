# Main-task subtask review validation

The owner selects the execution's pending review, displays its title and recorded
commit range, and sends approval/rework to that issue and submitted HEAD. Its
prompt and complete task transcript remain visible on Output. Intermediate review
does not expose final delivery actions or aggregate change counts. Final delivery
returns after the issue plan is approved.

Review loads are scoped to a selection and discarded when that selection changes.
Rework clears drafts; approval discards unsent line comments; final diff caches are
invalidated on either action. Empty ranges, legacy task-range fallback and failed
loads with retry are explicit. IPC rejects a stale issue or submitted HEAD.

Validation on Windows, Node 24.17.0, using the existing local node_modules directory
(verified to be a normal directory, not a shared link):

- `npm run typecheck`: passed.
- `npm run typecheck:tests`: passed.
- `npm test -- tests/issue-tracker-git.test.ts tests/issue-tracker.test.ts tests/task-steering.test.ts`:
  passed, 3 files and 4 tests. The Git range scenario now uses real approval/rework
  IPC across two sequential issues, checks each isolated diff, and checks the
  reworked range and legacy fallback. Existing scheduling/final-delivery coverage
  also verifies stale review rejection and pending-comment disposal.
- `npm run test:e2e -- tests/e2e/task-review.spec.ts tests/e2e/subtask-lifecycle.spec.ts tests/e2e/task-panels.spec.ts`:
  passed, 23 tests. Includes owner-only two-issue review, rework, draft reset,
  second-issue isolation, final combined diff, continuous output, late-response
  rejection, empty/failed/legacy ranges and existing line-comment/delivery checks.
- `npm run test:e2e -- tests/e2e/task-review.spec.ts`: passed, 14 tests after the
  final removal of an unguarded feedback reset.
- `npm test -- tests/git-delivery.test.ts tests/task-deletion.test.ts tests/ipc-handlers.test.ts`:
  passed, 3 files and 30 tests after making fixture line endings deterministic.
- `git diff --check`: passed.

Earlier failures were investigated rather than skipped:

- The original Git lifecycle test repeatedly failed deleting a temporary worktree
  on Windows. Git was launched inside the directory it was removing. Cleanup now
  launches from the shared Git directory; the required suite passes.
- The new browser test originally emitted events before app initialization.
  It now waits for the saved transcript before emitting live events. A legacy
  rework fixture also skipped its working state while a request was in flight;
  it now waits for that state. Review revisions guard late action completion.
- Additional Git delivery checks found global autocrlf settings changing fixture
  bytes. Temporary fixture repositories now explicitly disable autocrlf, retaining
  the original byte assertions.

Visual review: inspected the saved 1440x900 and 900x650 browser fixture screenshots.
The main task retains its title; subtask lists stay collapsed; second review shows
only second.txt, with approval and feedback visible. Output contains planning and
both issue turns. Final review has two files and restores Open PR / final approval.
The two-subtask interactions and one rework were driven by Playwright against the
real renderer with a mocked Electron bridge; Git behavior was verified separately
with temporary real repositories.

Live desktop interaction was unavailable: `orca skills get computer-use` failed
with “The term 'orca' is not recognized as a name of a cmdlet, function, script
file, or executable program.” No live Electron manual click-through is claimed.

Screenshots: [wide review](second-review-wide.png),
[narrow review](second-review-narrow.png), [continuous output](continuous-output.png),
[combined final review](combined-final-review.png).

Child-navigation removal belongs to the next planned issue and is intentionally
not included in this issue's implementation.
