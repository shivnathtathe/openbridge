# Architecture

OpenBridge is a local MCP server and a Claude Code channel client adapter,
coordinated by one authenticated loopback broker per configured workspace.

## Module boundaries

- **src/adapters/opencode.js** owns the native OpenCode send-and-wait request,
  status validation, upstream authentication and text-only reply extraction.
- **src/broker/server.js** composes the HTTP server and routes requests. It wires
  the other broker modules together and runs channel-heartbeat expiry checks.
- **src/broker/services.js** owns upstream health checks, bounded startup,
  connection liveness and project-scoped session discovery. Process-launch
  dependencies are injectable for integration tests.
- **src/broker/requests.js** owns acceptance, source attribution, cycle detection,
  dispatch, completion and target-lock ordering. It persists delivery markers
  before contacting a target and does not silently resend uncertain work.
- **src/broker/journal.js** owns on-disk record loading and persistence. Pending
  records become unknown on recovery, and uncertain target locks are rebuilt.
- **src/claude/channel.js** is the stdio MCP channel spawned by Claude. It polls
  for correlated inbound requests and exposes the reply tool and shared tools.
- **src/claude/config.js** generates managed channel settings for both initial
  setup and later launches, so their entrypoint paths cannot drift independently.
- **src/cli/index.js** provides setup, diagnostics, discovery and launching.
- **src/core/runtime.js** resolves the caller workspace separately from installed
  module paths, loads configuration and connects to or starts the broker.
- **src/core/validation.js** provides shared request-boundary validation.
- **src/mcp/server.js** is the OpenCode-facing stdio executable.
- **src/mcp/tools.js** exposes discovery, adapter-specific calls and retrieval.

## Message flow

OpenCode calls an MCP tool. The tool sends a correlated request to the project
broker. For an OpenCode target, the adapter uses its HTTP message API. For a
Claude target, the selected channel receives a notification, and Claude sends
one or more correlated replies through the channel's reply tool.

The target application is selected by tool name. The provider/model fields in
the prompt identify the sender, not a target override. Application identity and
model vendor identity remain separate; launch settings and caller-supplied data
are labelled rather than represented as independently observed facts.

## State and lifecycle

Workspace state lives in .openbridge, never in the installed package. Journal
records retain their existing format during this layout refactor. Source files
and tests do not own or copy private conversation history into the npm package.

Broker health carries a protocol generation and the resolved workspace path.
Clients reject incompatible cached processes. Each new workspace chooses an
available loopback port during setup; existing configuration is preserved.

MCP subprocesses, the broker and the Claude terminal are separate lifetimes.
Moving source files does not update a running process's cached modules. Setup
regenerates managed configuration, but an operator still restarts old processes.

## Tests and distribution

Tests live under tests and use controlled HTTP endpoints plus real MCP stdio
clients. The packaging test additionally installs the actual npm archive into a
different project and exercises the installed command, not a repository path.

The npm allowlist includes src, the logo, package metadata and npm's automatically
included README. Tests, development scripts, architecture/history documents,
credentials, generated configurations and captured sessions are excluded.
