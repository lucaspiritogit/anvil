// Command contract adapted from @lpirito/valence 0.1.0, by lpirito.
export const help = `Valence, the Anvil issue tracker for agents.

Usage: vl [--project <directory>] <command> [options]

Commands:
  init                 Check existing Anvil storage readiness
  status               Check Anvil storage and report its database path
  parent create <title> Create a parent issue, optionally with --description
  parent create --file <path> Create a parent issue from JSON
  parent update <id>    Replace a parent's title or description
  parent show <id>      Show a parent issue
  parent list          List parent issues in creation order
  create <title>       Create a queued issue
  create --file <path> Create an issue from a JSON object
  update <id>          Replace supplied fields of a queued or blocked issue
  show <id>            Show issue details, checklist, and dependencies
  list                 List all issues in creation order
  ready                List ready issues by priority, then creation order
  claim                Atomically start the next ready issue
  start <id>           Start a queued issue whose dependencies are complete
  submit-review <id>   Submit a working issue for developer review with checklist confirmation and evidence
  approve <id>         Approve an issue in review, marking it complete
  reject <id>          Reject an issue in review, returning it to working with evidence cleared
  block <id>           Manually block queued, working, or review work
  requeue <id>         Return blocked, interrupted working, or review work to the queue

Anvil storage:
  Use the launcher supplied by the owning Anvil profile. It sets ANVIL_DATABASE_PATH.
  --project <directory> selects a registered canonical project. From a worktree,
  supply the original project directory. --file stays relative to the caller.
  init checks readiness only. Open Anvil to create or migrate its database.
  --local and --config are obsolete and rejected. No separate tracker is created.

Parent creation:
  --anvil-task-id <id> is required and must belong to the selected project.
  JSON equivalent: {"anvilTaskId":"<id>","title":"<title>","description":"..."}

Issue fields for create and update:
  --parent <id>        Required on create. Parent issue that owns this issue
  --description <text> Required on create
  --checklist <text>   Required on create, repeat for each item
  --validation <text>  Required on create
  --label <text>       Repeat for each label
  --priority <value>   urgent, high, medium, or low. Default: medium
  --dependency <id>    Repeat for each dependency
  --title <text>       Update only
  --file <path>        JSON input instead of field flags

Completion (submit-review):
  --confirm-checklist  Explicitly confirm every checklist item
  --evidence <text>    Required validation evidence
  --file <path>        Alternatively, JSON with checklist booleans and evidence
  Approval is developer-only: approve moves a review issue to complete and
  reject returns it to working with evidence cleared.

All commands accept --json and --help.
Use --parent <id> with list, ready, or claim to select one parent's issues.
Create a parent first. Each child issue must reference an existing parent.
--json also formats help, version, and errors. Errors go to stderr with exit code 1.
Commands use only the existing Anvil database. No desktop startup or task recovery.
Array fields replace the whole array. Use update --file with [] to clear an array.
`
