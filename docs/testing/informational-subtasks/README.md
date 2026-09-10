# Informational subtasks validation

Issue: `9c5fd452f00b1806`

Subtask sidebar rows retain titles, statuses, indentation, expansion and search matching. They contain no navigation handler, button/link semantics, tab stop or selection marker. The owning task provides output, task metadata, issue details and the pending subtask's review controls. Old child selections render the owner; opening the task normalizes the selection and loads its complete output.

Reference audit removed `useIssueEvents`, `mergeIssueEvents`, their child-only unit suite and the child activity fallback. Shared `TaskEvent.issueId` attribution, tracker metadata, issue selection within the Issues panel, and per-issue diff/approval/rework APIs remain. Browser coverage previously opening child views now checks the owning task, including the additional references found in `task-panels.spec.ts`.

## Commands and results

All validation commands ran directly with visible output, using this worktree's existing local node_modules directory (verified to have no link target).

- `npm run typecheck`: passed on the final renderer changes. An intermediate run caught an unused sidebar store selector, which was removed.
- `npm run typecheck:tests`: passed.
- `npm test -- tests/task-issues-refresh.test.ts tests/task-deletion.test.ts`: passed, 2 files and 15 tests.
- `npm run test:e2e -- tests/e2e/sidebar-subtasks.spec.ts tests/e2e/subtask-lifecycle.spec.ts tests/e2e/task-review.spec.ts tests/e2e/task-issues.spec.ts tests/e2e/task-deletion.spec.ts tests/e2e/task-panels.spec.ts`: final run passed all 31 tests in 46.2 seconds. This includes all five required suites plus the repurposed task-panels suite.
- Initial browser run: 28 passed, 3 failed. Two new keyboard assertions incorrectly activated the next parent after tabbing past subtasks; corrected to verify focus cannot enter a child and keyboard activation stays on the focused owner. The existing Issues retry test raced polling after clearing its error; its fixture now clears the error on the actual Retry click, preserving the assertion that retry recovers.
- `git diff --check`: passed.
- The child-view unit suite was deleted with its unused helper; there is no retained child-only unit suite to run.

## Visual and interaction evidence

Manually inspected saved browser screenshots for parent selection, compact readable subtask rows, main-task metadata/actions, responsive review controls and continuous output. At 1440px and 900px, review shows only the second submitted range, with Approve, Request changes, feedback and file selection accessible on the owner. Continuous output contains planning plus both issue turns. The 900x500 sidebar capture shows the focused parent; its children remain below the scroll viewport. The 900x650 review and 900x500 settled captures show the informational rows themselves.

Browser interaction checks verify child clicks do not navigate, Tab skips rows, attempted focus cannot enter a row, parent keyboard activation works, and no child carries aria-current. They also cover expansion, live row updates, search/project filters, settled owners, deletion, stale child selection, issue details, two successive reviews, rework, final review, steering and output preservation.

Screenshots:

- [Wide sidebar and focused parent](sidebar-subtasks-1440.png)
- [Narrow focused parent](sidebar-subtasks-900.png)
- [Wide settled search result](sidebar-settled-1440.png)
- [Narrow settled search result](sidebar-settled-900.png)
- [Wide subtask review on owner](second-review-wide.png)
- [Narrow subtask review on owner](second-review-narrow.png)
- [Continuous task output](continuous-output.png)
- [Combined final task review](combined-final-review.png)

Live desktop interaction was not performed. The computer-use skill's discovery command, `orca skills get computer-use`, failed with: `The term 'orca' is not recognized as a name of a cmdlet, function, script file, or executable program.` Interaction evidence above comes from Playwright; manual evidence is visual inspection of those browser captures.
