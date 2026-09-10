# Codex MCP review regression

The `mcp-review` scenario in `tests/fixtures/codex-app-server.cjs` is a fake
Codex provider connected to a real `IssueToolServer`. It uses only the injected
MCP URL/headers, discovers the tool schema, reads the current issue, checks tool
errors, and submits the results of its assertions. It retains its MCP client
across planning and implementation to exercise the existing stable task capability.
`tests/issue-tools.test.ts` verifies persisted review status and the `TaskIssues`
developer-review pause, including rejecting successful prose without submission.
The fixture is transport coverage, not proof that a model calls tools.

The opt-in live test uses an authenticated, file-backed Codex profile:

```sh
ANVIL_LIVE_CODEX_HOME=/absolute/path/to/authenticated/codex-profile npm test -- tests/issue-tools.test.ts -t 'live Codex'
```

It requires `codex` on PATH and network/model access. It creates a disposable
SQLite database and Git repository, asks Codex to validate and commit a file,
and verifies real MCP submission and the persisted developer-review pause.
It uses the specified profile (which may receive Codex session/auth updates);
it does not copy credentials or approve the issue. Normal test runs skip it.

On 2026-09-10, codex-cli 0.154.0 with authenticated ChatGPT completed the live
scenario. It ran a Node strict assertion for `smoke.txt`, committed
`cf23fe36668b7fa53de6ced6408e947ce0f5e003` in the disposable repository, called
`anvil_submit_review` with both checklist confirmations and actual command
results, and reached persisted phase `reviewing`. The targeted live command
exited 0 (one passed, seven filtered out). A preceding live run also submitted
successfully but failed process-tree cleanup; the rerun passed cleanup without
a production change. This does not reproduce or explain the originally reported
blocked session, and no MCP transport defect was demonstrated.

The expanded suite also exposed scheduler doubles that parsed parent ownership
from the old planning prose. They now resolve the test task's parent from the
tracker, preserving the scheduler and final-diff assertions without reintroducing
internal ownership details into prompts.

Final validation on 2026-09-10:

```sh
npm test -- tests/codex-app-server.test.ts tests/issue-tools.test.ts tests/task-prompts.test.ts tests/valence-integration.test.ts tests/issue-tracker.test.ts tests/issue-tracker-git.test.ts tests/opencode-acp.test.ts --reporter=verbose
npm run typecheck
npm run typecheck:tests
git diff --check
```

All exited 0: seven suites, 53 tests passed, one opt-in live test skipped in the
normal run; both TypeScript checks passed. The provider suites emitted process
enumeration timeout warnings but passed. Earlier suite failures identified the
stale parent-prompt test assumptions and an incorrect assertion about where the
process manager injects MCP; those test assumptions were corrected before the
passing run. Local dependencies were already installed and `node_modules` was
verified not to be a symlink.
