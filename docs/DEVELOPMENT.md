# Development

## Source commands

From the source checkout, install dependencies with npm ci. Use npm test for the
suite, npm run setup for workspace configuration, npm run sessions for discovery,
and npm run claude for the interactive channel-enabled reviewer.

The installed command is openbridge. Internally it maps to src/cli/index.js.
The installed MCP executable is openbridge-mcp, mapped to
src/mcp/server.js. Consumers do not depend on the repository's directory layout
or access to its private GitHub source.

## Test organization

- tests/opencode.test.js covers the upstream adapter and MCP tool registration.
- tests/broker.test.js covers discovery, metadata, native channel replies,
  duplicate requests, late replies, cycle detection, authentication and recovery.
- tests/packaging.test.js verifies exact archive contents, installs the archive
  into a separate project with spaces in its path, and tests initial setup and
  migration of cached channel paths. Registry access may be needed for package
  dependencies; it does not contact any model service.

Fixtures are created beneath ignored .openbridge-test-* and
.openbridge-package-test-* directories and cleaned up by their tests. Tests must
not mutate the live .openbridge workspace state.

## Distribution checks

Review npm pack --dry-run --json before a release. The tarball must contain only
runtime modules under src, assets/logo.png, README.md, package.json, and any
explicitly approved license file npm includes automatically. The allowlist is
independent of GitHub visibility and .gitignore.

The npm package is named @shivnathtathe/openbridge-mcp and is configured for public npm
publication, independently of its private GitHub repository. The license field
is UNLICENSED: no open-source license has been granted. A private GitHub
repository does not make a public npm package's shipped runtime code private.

## Updating from earlier layouts

Rerun setup after an update. It refreshes the OpenCode executable path and every
managed Claude MCP file while preserving the workspace token and target IDs.
It also preserves unrelated OpenCode MCP settings. Backups are stored under
.openbridge. Restart old broker, Claude and OpenCode processes after regeneration;
they do not hot-reload entrypoint changes.

The historical development narrative is in DEVELOPMENT_STORY.md. Its references
to root-level filenames describe the earlier layout, not current executable
paths. Raw session archives remain local under the ignored hisotry_conco folder.
