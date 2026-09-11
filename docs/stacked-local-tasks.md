# Stacked local tasks

Choose **Stack on task** in the composer to start from another active task's latest committed branch head. Uncommitted parent changes are not copied. Each task keeps its own worktree and agent process.

Planning issues declare `expectedFiles`, using repository-relative paths. Anvil compares these declarations with other active tasks' declarations and committed changes. A matching task appears as a dismissible suggestion. Accepting it queues a rebase if the agent is running. The current turn finishes before Git changes its worktree.

A stacked task cannot merge until its parent merges and its restack completes. Merging the parent moves children onto the project branch and refreshes their final diffs. Descendants remain attached to their immediate parent. Pending operations, conflicts, parent links and suggestions survive restart.

Deleting or cancelling a parent moves its children onto the project branch while retaining inherited commits that the children may need.

A conflict aborts the automatic rebase and preserves the branch. Use **Resolve with agent**, or resolve the worktree manually and choose **Retry restack**. Dirty worktrees also require intervention. Approval and continuation stay blocked until the restack succeeds. When a pending issue review's commits are rewritten, its review range expands to the refreshed task diff so approval cannot silently use an obsolete range.

Validation lives in `tests/task-stacks.test.ts` and `tests/e2e/task-stacks.spec.ts`, alongside the existing Git delivery, issue tracker and migration suites.
