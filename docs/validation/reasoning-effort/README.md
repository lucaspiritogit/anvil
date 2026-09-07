# Unified reasoning verification

Validated issue bbf929a93bbc47db on 2026-09-07 against the completed consolidation. This commit adds regression assertions and evidence; it changes no production behavior.

## Automated checks

All commands exited 0 with local, nonsymlinked node_modules:

- `npm run typecheck`
- `npm run test:issue-tracker`, all 24 registered suites
- `npx playwright test tests/e2e/composer-*.spec.ts`, 21 passed
- `npm run build`
- `git diff --check`

Composer coverage includes distinct native option sets for the same model ID under Codex and OpenCode, separate saved choices, model switching, reload, new and malformed storage, removed options, no-effort models, discovery failure, switching away during discovery, and immediate submission after delayed discovery for both agents. Task payload assertions require the selected reasoningEffort and exclude thinkingLevel and modelEffort.

Existing IPC tests exercise managed Git and non-Git task starts. Existing process-manager tests forward the string to both executors. Codex protocol assertions now check native-max on fresh threads, low on resumed threads, and absent configuration on fresh and resumed threads when effort is omitted. ACP assertions check max on fresh sessions, high on resumed sessions, omitted effort in both cases, grouped options, unsupported selections, and rejection diagnostics. No new node suite was introduced, so registration is unchanged.

## Browser UI inspection

An agent-operated headed Chromium session used the real renderer with the existing mocked desktop API at `/tests/e2e/fixture/?reasoningModels`, at 1280 by 900. This was a browser fixture check, not an Electron/backend end-to-end test. The screenshots were opened and visually inspected: the single selector fits beside the agent and model, with readable text and no clipping.

1. Selected Codex / GPT 5 Mini, focused Reasoning effort, and typed `m` using the keyboard. The selection changed from High to Maximum reasoning, whose ID is native-max.
2. Reloaded and confirmed native-max persisted.
3. Selected OpenCode / deepseek-v4, focused the selector, and typed `m`. Its selection changed from high to max.
4. Switched to reasoner and observed its medium default, then returned to deepseek-v4 and observed max.
5. Reloaded and confirmed max persisted. Switched back to Codex and confirmed native-max.

Screenshots: [Codex](codex.png) and [OpenCode](opencode.png). These model options are fixture values, not claims about the installed providers' catalogues.

## Installed backend checks

Both executables were available. A temporary harness called the production adapter clients in a new temporary directory with the prompt `Reply with OK only. Do not call tools or change files.` It used discovered options and a 45-second cancellation limit per request.

Codex advertised gpt-5.4-mini with low, medium, high and xhigh, default medium. Both fresh and resumed requests succeeded and returned OK. Instrumentation at CodexAppServerConnection.request recorded:

```json
{"wire":"thread/start","effort":"low"}
{"wire":"thread/resume","effort":"low"}
```

The captured value was params.config.model_reasoning_effort. Both results used the same session ID. Protocol fixtures additionally demonstrate that changing the input changes the exact wire value.

OpenCode advertised openai/gpt-5.4-mini with none, low, medium, high and xhigh. Fresh and resumed requests with low both failed with `Internal error: Token refresh failed: 401`. The fresh attempt returned a session ID, which was used for the resumed attempt. Live OpenCode generation could not be validated with the installed credentials. Exact ACP effort translation is verified by the passing fixture transcript assertions described above; no successful live OpenCode generation is claimed.

## Preference and schema audit

The composer stores preferences in localStorage under anvil-composer-preferences-v2. It stores a selected agent, model IDs by agent, and reasoning IDs keyed by JSON.stringify([agentId, model]). It does not read or migrate the old anvil-composer-preferences key. Malformed values are sanitized. Removed saved efforts resolve to an advertised default or the first advertised option and are persisted. Models without options and failed discovery omit effort; saved entries are retained but not sent without matching advertised metadata.

The source audit found no thinkingLevel, modelEffort, ThinkingLevel or THINKING_LEVEL references in src. Remaining thinking event categories describe output, not a selection setting. Adapter-specific protocol names are intentional. There is no fixed global effort list or compatibility alias. The generic CLI placeholder uses reasoningEffort directly.

This commit changes no database schema or migrations and runs no reset. The composer preference replacement requires no schema reset; existing old preference keys simply remain unused. No user data was reset during validation.
