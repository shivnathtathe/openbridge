import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { brokerFetch, ensureBroker, loadConfig } from '../core/runtime.js';

export function registerBridgeTools(server) {
  const run = callback => async (args, extra) => {
    try {
      const result = await callback(args, extra);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }], structuredContent: result };
    } catch (error) {
      return { isError: true, content: [{ type: 'text', text: error.message }] };
    }
  };
  server.registerTool('list_sessions', {
    description: 'List project OpenCode and registered/configured Claude Code sessions with exact session IDs, names, application provider, model provider, model, reachability and status. Starts the bridge and, if configured, the OpenCode HTTP server; does not launch Claude sessions just to list them.',
    inputSchema: {},
  }, run(async () => {
    const config = await loadConfig();
    await ensureBroker(config);
    return brokerFetch(config, '/sessions', undefined, AbortSignal.timeout(25000));
  }));

  for (const target of ['opencode', 'claude']) {
    server.registerTool(`ask_${target}`, {
      description: `Send to a ${target} session selected from list_sessions and wait for its correlated reply. Starts configured services if absent. provider/model identify the SENDER, not target selection; provider is the sending application (opencode or claude). Supply source_session_id when known. Do not create circular waits. A timeout never authorizes resending; use get_request with the returned request ID.`,
      inputSchema: {
        session_id: z.string().min(1).max(128),
        message: z.string().min(1).max(100000).refine(value => !!value.trim(), 'Message must not be blank'),
        provider: z.enum(['opencode', 'claude']).describe('Sending application, not LLM vendor'),
        model: z.string().min(1).max(200).describe('Sending model, e.g. gpt-6.1-sol; use unknown if unavailable'),
        source_session_id: z.string().min(1).max(128).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    }, run(async (args, extra) => {
      const config = await loadConfig();
      await ensureBroker(config);
      const requestId = randomUUID();
      // Retain the request ID even if HTTP transport or MCP cancellation fails.
      try {
        return await brokerFetch(config, '/ask', {
          request_id: requestId, target_provider: target, ...args,
          source_session_id: process.env.OPENBRIDGE_SESSION_ID || args.source_session_id,
          provider: process.env.OPENBRIDGE_SENDER_PROVIDER || args.provider,
        }, AbortSignal.any([extra.signal, AbortSignal.timeout(config.request_timeout_ms + 25000)]));
      } catch (error) {
        throw new Error(`${error.message} Request ID: ${requestId}. Check get_request before retrying; the target may still be working.`);
      }
    }));
  }
  server.registerTool('get_request', {
    description: 'Retrieve a request status or late reply by request_id, including after a timeout. Does not resend the message.',
    inputSchema: { request_id: z.string().uuid() },
  }, run(async ({ request_id }) => {
    const config = await loadConfig();
    await ensureBroker(config);
    return brokerFetch(config, `/requests/${request_id}`);
  }));
}
