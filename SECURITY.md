# Security

## Agent permissions

Anvil runs agent CLIs with full access to the task worktree and host machine.

- Codex runs with the `dangerFullAccess` sandbox policy, equivalent to
  `--dangerously-skip-permissions`. It executes commands without asking for
  approval.
- Opencode runs through its ACP server and follows its own permission settings.

Only run tasks from prompts and repositories you trust. Every task gets its own
Git worktree, but the agent process itself is not sandboxed by Anvil.

## Server password

LAN and headless access use HTTP basic auth with username `anvil` and your
server password. Anvil stores only an Argon2id password hash, never the
plaintext password.

For an unattended headless LAN server, provide the password through a file:

```sh
ANVIL_SERVER_PASSWORD_FILE=/absolute/path/to/password npm run serve:lan
```

Without a password file, the first terminal launch prompts for a password. The
headless Tailscale command delegates access control to Tailscale and does not
read the password file.

## Network exposure

LAN mode uses plain HTTP, so use it only on a trusted network. Use Tailscale
HTTPS for access outside that network. The headless local mode
(`npm run serve`) binds to `127.0.0.1` without authentication; do not expose it.

The Electron **Connect to remote server** setting changes which Anvil server the
desktop client trusts and uses. Only enter addresses for servers you control or
trust. Plain HTTP can expose credentials and Anvil activity to other devices on
the network, so reserve HTTP remote targets for trusted LANs. Use HTTPS for
remote, shared, or untrusted networks and verify that the certificate belongs to
the intended server. Anvil accepts only an HTTP or HTTPS origin without embedded
credentials, a path, query string, or fragment.

The desktop target is stored in the local Electron profile, outside server and
workspace data. A saved local or remote selection takes precedence over
`ANVIL_SERVER_URL`; the environment value is used only when no saved selection
exists. This prevents a later environment change from silently redirecting a
client whose target was chosen explicitly.

## Unsigned builds

Release builds are unsigned for now, so your OS may warn on first launch.
Building from source is recommended until signing is set up.
