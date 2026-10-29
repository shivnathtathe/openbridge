import { resolve } from 'node:path';
import { atomicJson, root, stateDir, entrypoints } from '../core/runtime.js';

/** Managed channel configuration is generated in one place for init and launch. */
export async function writeClaudeConfig(session) {
  const path = resolve(stateDir, `claude-${session.session_id}.mcp.json`);
  await atomicJson(path, {
    mcpServers: {
      openbridge: {
        command: process.execPath,
        args: [entrypoints.channel],
        env: {
          OPENBRIDGE_PROJECT: root,
          OPENBRIDGE_SESSION_ID: session.session_id,
          OPENBRIDGE_SESSION_NAME: session.name,
          OPENBRIDGE_SESSION_MODEL: session.model,
        },
      },
    },
  });
  return path;
}
