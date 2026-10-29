<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://cdn.jsdelivr.net/npm/@shivnathtathe/openbridge-mcp@2.0.2/assets/white_logo.png">
    <source media="(prefers-color-scheme: light)" srcset="https://cdn.jsdelivr.net/npm/@shivnathtathe/openbridge-mcp@2.0.2/assets/logo.png">
    <img src="https://unpkg.com/@shivnathtathe/openbridge-mcp@2.0.0/assets/logo.png" alt="OpenBridge — connecting coding-agent sessions" width="360">
  </picture>
</p>

<p align="center"><strong>Let your coding agents talk to each other.</strong></p>

Local, project-scoped MCP communication between OpenCode and Claude Code sessions.
One npm package; no AgentAPI, Bun, database server, or hosted message relay.
Model inference still uses each agent's configured model service.

## Install and set up

Requires Node.js 22+, OpenCode, and an authenticated Claude Code version that
supports custom MCP Channels. Channels are currently a research preview.

### npm distribution

The npm package is **`@shivnathtathe/openbridge-mcp`**. Install globally, then initialize
from the project you want to connect:

```sh
npm install --global @shivnathtathe/openbridge-mcp
openbridge init
```

State belongs in the workspace's `.openbridge/`, not in the installed package.
`OPENBRIDGE_PROJECT` selects an explicit workspace. The GitHub source repository
can stay private; installed modules do not fetch application source from GitHub.
A public npm package still makes its shipped runtime code public.

Installing does not silently modify projects or launch sessions. Initialize
once, restart OpenCode, then use `ask_claude` to reuse or launch the configured
Claude target. Log in and approve any required Claude prompts when it opens.

### Source checkout

From the source project directory:

```bat
npm install
npm run setup
```

Setup creates `.openbridge/config.json` and merges the bridge into
`opencode.json`, retaining other settings and saving a first backup. It does
not modify your home-directory configuration. Restart OpenCode to load the
new tools. Setup accepts standard JSON; it does not rewrite JSONC files.

For the first Claude connection from a source checkout:

```bat
npm run claude
```

For a global npm installation, use `openbridge claude` instead. Complete any
login, workspace trust, MCP consent and development-channel
confirmation in that terminal. Your organization's channel policy must allow
the feature. The launcher supplies a native `--session-id` UUID, display name,
model, generated MCP config, and the custom-channel opt-in flag. It does not
bypass tool permissions. The generated config also exposes the bridge tools
inside Claude so Claude can initiate conversations with OpenCode.

An arbitrary Claude window opened without the channel is not discoverable or
addressable through this bridge. Use the launcher for a bridge-enabled session.

## Tools

### `list_sessions()`

Returns exact session IDs, display names, **application provider**, model,
model vendor when known, connection status, and metadata provenance:

```json
{
  "session_id": "ses_...",
  "name": "API implementation",
  "provider": "opencode",
  "model_provider": "openai",
  "model": "gpt-6.1-sol",
  "status": "idle",
  "reachable": true,
  "metadata_source": "opencode_api"
}
```

For Claude, the ID is the UUID supplied to Claude's `--session-id` argument.
Its name and model are **launch settings**, not live observations of later
`/rename`, `/model`, or automatic fallback changes. For example, `sonnet` is a
configured model alias, not an independently verified full model identifier.
`model_provider` is null when not observed; it is never guessed from the name.
Disconnected configured Claude targets remain visible as `offline` and can be
started on demand. Only this project's registered/configured Claude sessions
are listed; the bridge does not scan Claude's private history directory.

`channel_connected` means MCP initialized and the channel heartbeat is live.
It does **not** prove that Claude accepted channel events: Claude's channel
protocol does not acknowledge delivery. `delivery_confirmed` becomes true
after the connection's first successful reply.

### `ask_opencode` / `ask_claude`

The **tool name selects the target adapter**. Supply a target ID from discovery:

```json
{
  "session_id": "TARGET_NATIVE_SESSION_ID",
  "message": "Please review these changes and explain any bugs.",
  "provider": "opencode",
  "model": "gpt-6.1-sol",
  "source_session_id": "ses_SOURCE"
}
```

- `provider` means the **sending application**: `opencode` or `claude`.
- `model` identifies the **sending model**, not a target-model override.
- `source_session_id` is optional but should be supplied when known.
- A launcher-managed Claude channel supplies its source ID/application itself.
- When an OpenCode source ID is given, its model/vendor are looked up through
  the OpenCode API. Otherwise sender model attribution is caller-supplied.
- Claude source model attribution is its launch configuration when connected.

The receiver sees a clearly labelled collaborator envelope containing the
sender application, model, source session, provenance and request ID. Sender
metadata is attribution, not a permission grant or higher-priority instruction.

Results contain `request_id`, request status, sender metadata, receiver metadata
when available, and the reply. Status is one of `pending`, `completed`, `failed`,
`unknown`, or `released`. Inspect it even when the MCP transport call succeeds.

`ask_other` remains available as a **legacy OpenCode-only tool** for existing
clients. It uses the original direct HTTP implementation; use the new tools
for sender metadata, managed startup, journaling and cross-process coordination.

### `get_request(request_id)`

Retrieve a result or late Claude reply without resending. A tool/HTTP timeout
is not evidence that the target stopped. Do not automatically retry a prompt
whose delivery is uncertain.

## Automatic startup

The MCP client starts the stdio server. On first use of the new tools:

1. The server health-checks the authenticated loopback broker.
2. If absent, it starts the broker as a detached Node process, using a project
   startup lock to avoid duplicate launches. Logs go to `.openbridge/broker.log`.
3. Discovery and OpenCode requests check `/global/health`. If unreachable and
   configured for auto-start, the broker launches `opencode serve` in the
   background and polls readiness. A healthy existing server is reused.
4. `ask_claude` reuses a live channel or launches the **selected configured
   Claude session** in a terminal. Discovery alone does not launch Claude.

Claude's custom-channel flag requires interactive confirmation. Consequently
Claude startup opens a terminal rather than claiming to launch a fully hidden,
unattended channel. Once connected, messaging is automatic. If consent is still
pending after the bounded startup wait, the request fails **before delivery**;
complete the terminal prompts and submit again.

Auto-opening a terminal is implemented for Windows (PowerShell Start-Process)
and Linux with `x-terminal-emulator`. On macOS, run `openbridge claude` in a terminal.
Claude executable selection defaults to `claude` on PATH; a session can set a
native executable path in its optional `command` field. Native Windows npm
`.cmd` shims are not supported for this Claude executable field.

OpenCode's configured startup command must match its configured URL. The
default is `http://localhost:4096` with `opencode serve --hostname 127.0.0.1
--port 4096`. Auto-start is restricted to loopback URLs. Authentication or
unexpected HTTP/protocol failures do not trigger another server launch.
Set `OPENCODE_SERVER_PASSWORD` and optionally `OPENCODE_SERVER_USERNAME` in the
MCP environment if your existing server uses Basic Auth; auto-started OpenCode
inherits them. Credentials are not included in tool outputs.

The broker stays running when an MCP client exits. Restart it after changing
`.openbridge/config.json`; existing processes keep the config they loaded.
The bridge never kills an existing OpenCode or Claude process automatically.
Health includes the broker protocol generation and workspace identity; an older
incompatible process produces a restart-required error rather than being reused.
New workspaces select an available broker port at initialization; existing
configured ports remain unchanged. A selected port can still be occupied later,
so port/authentication failures must be resolved before startup succeeds.

## Request safety and recovery

- One active request per target is enforced in the shared broker, across MCP
  clients. Known self-calls and circular waits are rejected. Cycle detection
  depends on the supplied source IDs and only covers requests through this broker.
- Every Claude event and reply carries a request ID. Claude calls `bridge_reply`
  with `final:true` to finish. Partial replies use `final:false`.
- Requests are journaled under `.openbridge/requests/`. Broker restarts mark
  unfinished work `unknown` instead of silently redelivering it.
- Unknown requests keep a target lock until you inspect the target and explicitly
  release it. Never use release merely because waiting took too long:

  ```bat
  openbridge release REQUEST_UUID --confirm-target-is-idle
  ```

- A disconnected Claude channel or expired heartbeat makes its pending work
  uncertain. Notification write success is not proof of model processing.
- Late Claude replies are retrievable while the broker/channel remain connected.
  OpenCode HTTP timeouts do not recover a late reply automatically; inspect its
  native conversation before deciding whether to retry.
- Journaling is bounded to 500 records. When full, archive completed records
  while the broker is stopped and restart it. Request files contain message and
  reply text: keep them private. No automatic log/content rotation is implemented.
- Broker startup locks are intentionally conservative. After a crash during
  launch, remove a stale `.openbridge/broker-start.lock` only after verifying
  that no startup is in progress.
- The Claude launcher records an attempted launch to choose `--resume` later.
  If the first attempt failed before creating the conversation, remove that
  session's `.openbridge/claude-UUID.started` marker before launching again.

The broker binds to `127.0.0.1`, authenticates each request with a project-local
random token, rejects browser-Origin requests, caps input/reply sizes and does
not put user messages into shell commands. `.openbridge/` is gitignored. File
modes request owner-only access on POSIX; Windows ACLs are inherited from the
project directory. This is local collaboration infrastructure, not an isolation
boundary against another process running as the same OS user.

## Commands

```sh
openbridge init
openbridge sessions
openbridge doctor
openbridge claude
openbridge claude --session UUID --window
openbridge release REQUEST_UUID --confirm-target-is-idle
```

From a source checkout use `node src/cli/index.js` in place of `openbridge`,
or the corresponding npm scripts. `npm test` runs the development test suite.
`npm run export:history` is a project-specific development helper and is not
shipped in the npm package.

The session configuration is generated locally, including a default Claude
reviewer UUID. Add more objects to `claude_sessions` in the private config with
distinct native UUIDs, `name`, `model`, and `auto_start` settings, then restart
the broker. Namespaced target identifiers remain a roadmap item: for now select
the tool (`ask_claude` / `ask_opencode`) and pass the native ID.

## Repository layout

| Directory | Responsibility | In the npm package? |
| --- | --- | --- |
| `src/adapters/` | OpenCode HTTP adapter | Yes |
| `src/broker/` | HTTP routes, service lifecycle, request coordination, journal | Yes |
| `src/claude/` | Native MCP channel and generated channel configuration | Yes |
| `src/cli/` | Installed `openbridge` command | Yes |
| `src/core/` | Workspace runtime, entrypoint paths, shared validation | Yes |
| `src/mcp/` | MCP server and shared tool registration | Yes |
| `assets/` | Original light-theme logo and white dark-theme logo | Both logo variants |
| `tests/` | Adapter, broker and real npm-install smoke tests | No |
| `scripts/` | Development utilities | No |
| `docs/` | Architecture and development story | No |
| `.openbridge/` | Local configuration, credentials, logs, request state | No |
| `hisotry_conco/` | Preserved local conversation archives | No |

Architecture, development notes and the development story are maintained in
`docs/` in the private source repository and require repository access. These
source-only documents are excluded from the runtime npm archive; the installation
and operating instructions above are included with the npm package.

## Upgrading from the flat prototype layout

Run initialization again after installing an update. It preserves the existing
token and configured session IDs, refreshes all managed Claude MCP file paths,
and updates OpenCode's entrypoint atomically. Original client config backups now
live inside `.openbridge/` rather than alongside source files.

Close the old bridge-enabled Claude terminal and restart the project broker and
OpenCode before using the new layout. A process already running old code does
not reload moved modules or generated settings automatically. Initialization
does not forcibly terminate active conversations.

## Verification and current limits

Tests exercise real MCP stdio clients, the shared HTTP broker, and a real channel
process against controlled mock OpenCode endpoints. Coverage includes metadata,
both communication directions, reply matching, timeouts/late replies, duplicate
requests, circular waits, authentication and crash recovery. Unit/integration
tests do not prove upstream Claude preview behavior on every platform. The
package smoke test also builds the tarball, installs it into a separate project
whose path contains spaces, runs the installed command, and checks migration of
managed paths while preserving user configuration. Installing test dependencies
may need the npm registry; no model service is started by this smoke test.

A live Windows test also completed successfully: OpenCode sent a message through
`ask_claude`, Claude replied through the native channel, and its response correctly
repeated the sender application and model. Claude identified its own model in
the reply; the broker separately retained the configured `sonnet` alias.

This is a hardened working implementation, not a claim of production certification.
Remaining work includes live Claude identity/title updates, broader platform
testing, automatic journal retention, explicit daemon management, and stronger
end-to-end delivery acknowledgments where upstream interfaces permit them.

Protocol references:
- https://code.claude.com/docs/en/channels-reference
- https://code.claude.com/docs/en/cli-reference
- https://opencode.ai/docs/server/
