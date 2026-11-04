# Ship-first Anvil

## Philosophy change

Today Anvil is **review-gated**: work tasks pause after every issue for approval
(`review_each_issue` is the default), finished tasks land in "Ready to review",
and delivery goes through a preview modal (Merge task / Merge & Push / Commit).

New model: **agents work unattended, you steer and ship.** The diff is always
visible so you can read it while you talk to the agent, but nothing waits on a
review. When you like what you see, one click on **Ship** writes a commit
message with the task's agent and lands the change.

Decisions (confirmed):

| Topic | Decision |
| --- | --- |
| Ship on worktree tasks | Squash the task branch into **one commit** on the base branch with the AI-written message |
| Push | **Per-project setting** "Ship pushes to origin" (default off). Ship dropdown always offers the other variant |
| Per-step review gate | **Removed.** Work tasks always run to the end unattended |
| Confirmation | **One click.** Message is written to the activity log; dropdown has "Ship with message…" to edit first |

---

## Target UX

```
┌ sidebar ┐┌──────────── conversation ────────────┐┌──────── Changes ─────────┐
│ tasks   ││ task title · status · agent · stats  ││ 4 files +120 −31         │
│ ● Ready ││                                       ││ [Ship ▾]  [Send 2 notes] │
│   to    ││  agent output / tool calls / events   ││ ───────────────────────  │
│   ship  ││                                       ││ src/foo.ts        ▸      │
│         ││                                       ││  diff… [comment on line] │
│         ││ ┌───────────────────────────────────┐ ││ src/bar.ts        ▸      │
│         ││ │ steering composer  (+ note chips) │ ││                          │
│         ││ └───────────────────────────────────┘ ││                          │
└─────────┘└───────────────────────────────────────┘└──────────────────────────┘
```

- **Split view** (container ≥ ~1100px): conversation left, Changes pane right,
  resizable and collapsible. Below that width it falls back to the current tabs
  (Output / Changes / Issues).
- **Changes pane is always live.** While the agent runs it shows the worktree
  diff against `baseCommit` (including uncommitted edits), refreshed on task
  events. Once finished, it shows the final diff.
- **Ship ▾** lives in the Changes pane header (and the task header on narrow
  layouts). Dropdown: *Ship & push* / *Ship without pushing* (whichever is not
  the project default), *Ship with message…*, *Open PR*, *Rebase commits*.
- **Line comments feed the composer.** Commenting on a line adds a chip to the
  steering composer (`src/foo.ts:42 — "rename this"`). Sending the composer
  message sends the instruction plus all pending notes in one turn. The separate
  "Send N comments" button goes away (one place to talk to the agent).
- **States:** `Running` → `Ready to ship` → `Shipped` (or `Shipped · pushed`).
  Sidebar attention ranking treats "Ready to ship" the way it treats
  "needs review" today.
- **After shipping** the task stays open. A follow-up instruction makes new
  changes; the Changes pane shows only what is new since the last ship, and Ship
  becomes available again (incremental ship).

---

## Phase 1 — Ship pipeline + remove the review gate

Server-first, minimal UI swap. Usable on its own.

### 1.1 Remove per-step review
- `apps/server/src/tasks/task-execution.ts` (~L412): when an issue enters
  `reviewing`, always auto-accept (today only for `review_at_task_end`). Pending
  line comments still trigger a rework turn instead of accepting.
- Startup recovery: tasks currently parked in phase `reviewing` get
  auto-accepted so nothing is stuck after upgrade.
- Remove `tasks:approve-issue` / `tasks:reject-issue` handlers, the issue-review
  branch in `handlers/steering.ts`, the IPC request types, client-api methods,
  and store actions.
- Web: drop the review-policy picker in `TaskComposer.tsx`, the `moon-star`
  badges in `TaskView.tsx` / `SidebarTask.tsx`, `setReviewPolicy` in
  `composer-preferences.ts`, the App.tsx keybinding that toggles it, and the
  issue-review UI (Approve step / Request changes, issue diff section) in
  `TaskView.tsx`.
- Keep the `review_policy` DB column (ignored) to avoid a destructive
  migration; stop writing/reading it in protocol types later in cleanup.

### 1.2 Commit-message drafting for any task
- Generalize `agents/commit-message-draft.ts` to take a `TaskDiff` from either
  the working tree (local quick tasks) or the branch range
  `shippedCommit ?? baseCommit .. headCommit` (worktree tasks). Prompt also gets
  the task title and the follow-up messages since the last ship so the subject
  reflects what changed.
- Fallback when generation fails or times out: task title as subject. Shipping
  never blocks on the agent.

### 1.3 `tasks:ship` handler (`handlers/review.ts` or new `handlers/ship.ts`)
Input: `{ taskId, push?: boolean, message?: string }`. Inside
`withTaskOperation(store, taskId, 'ship', …)`:

1. Guard: task not running/finalizing, has changes, not mid-restack, parent
   already shipped (stacks).
2. Message = `input.message` or `draftCommitMessage(...)` (fallback to title).
3. **Local quick task:** reuse `gitDelivery.commitPaths` (same as
   `tasks:commit-quick`).
4. **Worktree task:** new `gitDelivery.squashMerge(projectPath, branchName,
   preview, message, guard)` in `git/merge.ts`:
   `git merge --squash --no-commit refs/heads/<branch>` then
   `git commit -m <message>` under the existing repo lock, same dirty-tree and
   target-branch checks as `merge()`.
   - Conflicts reuse the existing `pauseMerge` / merge-conflict flow (manual
     resolve or "Fix with agent"); `completeMergeConflict` must commit with the
     stored ship message instead of `--no-edit` when the operation is a squash.
5. Persist: `deliveryStatus: 'approved'`, new `shippedCommit` (the squash
   commit on target), `shippedHead` (task branch head that was shipped),
   `reviewedAt`. Record a system event with the message and short SHA.
6. If `push ?? project.shipPushes`: `getPushPreview` + `push` with
   `requiredCommit = shippedCommit` (the squash commit, not the task head,
   since the task head is no longer an ancestor of target).
7. Stacked children: restack with `restackTarget = { commit: shippedCommit,
   oldBase: shippedHead }`; existing `rebase --onto` in
   `git/task-branches.ts` already supports this.

Schema (`apps/server/src/db/schema.ts`, then `npm run db:generate`):
- `tasks.shipped_commit`, `tasks.shipped_head` (nullable text).
- `projects.ship_pushes` (bool, default false). `finishOnPush` stays as-is.

Protocol: `Task.shippedCommit?`, `Task.shippedHead?`, `Project.shipPushes`,
`IpcRequests['tasks:ship']`, validation in `handlers/validation.ts`, client-api.

### 1.4 Minimal UI swap
- New `ShipButton.tsx` (split button, pattern from `MergeActions` /
  `QuickCommitActions`). Progress label: *Writing message… → Committing… →
  Pushing…*. Errors inline; conflicts switch to the Output panel as today.
- "Ship with message…" opens a slimmed `CommitQuickTaskModal` (prefilled via
  draft, keeps the sync banner) for both local and worktree tasks.
- Replace `MergeActions`, the post-merge "Push" button and
  `QuickCommitActions` in `TaskView.tsx` with `ShipButton`. "Open PR" moves into
  the dropdown. `ApproveTaskModal` is deleted once nothing uses it.
- Labels: `reviewable` → "Ready to ship", `approved` → "Shipped".
  `taskNeedsReview` → `taskReadyToShip` in `packages/protocol/src/task-review.ts`.
- Project settings: "Ship pushes to origin" toggle.

**Check:** `npm run typecheck`; focused tests around merge/commit in `tests/`
(add squash-merge + conflict + push-guard cases).

---

## Phase 2 — Split view and unified composer

- `TaskView.tsx`: replace the tab strip with a two-column layout at
  `@min-[1100px]`; conversation column = `TaskOutput` + `TaskSteeringComposer`,
  right column = new `ChangesPane.tsx` (extracted `PatchFiles`, `CommitsMenu`,
  header with stats + `ShipButton`). Drag handle persists width in the store;
  collapse button hides the pane. Narrow layouts keep tabs.
- Issues panel moves into a collapsible section above the output (or a third
  tab only on narrow layouts) since it is now informational.
- Comments → composer: `TaskSteeringComposer` shows pending `TaskComment`s as
  removable chips. `tasks:steer` accepts the pending notes and includes them in
  the follow-up prompt (reuse `reviewPrompt` formatting from
  `agents/task-prompts.ts`), then marks them sent. Remove `comments:send` and
  the "Send N comments" button. Allow commenting while the agent runs (notes
  queue until the next send).
- `TaskResultBrief` / result notices: wording "Ready to ship".
- Update README "What it does" / "Usage" to describe ship-first.

---

## Phase 3 — Live diff, incremental ship, auto-ship

- **Live diff:** `tasks:live-diff` → `git diff <baseCommit>` inside the task
  worktree (tracked + untracked, same filters as `getWorkingTreeDiff`), throttled
  and refreshed on `task:updated` / tool-call events. Changes pane uses it while
  `status === 'running'`.
- **Incremental ship:** after a ship, follow-up turns set `deliveryStatus` back
  to `reviewable` when `headCommit !== shippedHead`; diff range becomes
  `shippedHead..headCommit`; the next squash merges only the new commits (merge
  base is already on target via the previous squash's tree, so use
  `rebase --onto shippedCommit shippedHead` on the task branch first, then
  squash).
- **Auto-ship** (opt-in per task in composer overflow, or per project): on
  successful completion with changes, run `tasks:ship` automatically. Off by
  default.
- Settlement: shipped tasks settle after the existing TTL unless a follow-up
  reopens them; consider shortening for auto-shipped tasks.

---

## Risks and open points

- **Squash vs stacks:** children branch from the parent's original commits.
  Restacking with `--onto shippedCommit shippedHead` handles it, but needs
  tests for multi-level stacks.
- **Push guard:** anything that checks "task head is an ancestor of target"
  (`getPushPreview` requiredCommit, `requireApprovedTask`) must switch to
  `shippedCommit` for squash-shipped tasks.
- **Existing tasks** already `approved` via merge have no `shippedCommit`; keep
  the old ancestry check as a fallback for them.
- **Dirty project checkout:** squash runs in the project checkout like merge
  does today, so the same "uncommitted changes" refusal applies; the Ship error
  should say which files block it.
- **Agent latency:** message drafting can take seconds; show progress and fall
  back to the title after a timeout (e.g. 30s).
