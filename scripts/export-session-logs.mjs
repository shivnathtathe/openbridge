import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { root, stateDir } from '../src/core/runtime.js';

const output = resolve(root, 'hisotry_conco');
const capturedAt = new Date().toISOString();
const targets = [
  { session_id: 'ses_e78e3ee07ffe6H7QoNlyvVfjzw', file: 'gpt61-orchestrator-session.json' },
  { session_id: 'ses_e78e3b1ccffeG4Ltg2vp3znALl', file: 'gpt56-reviewer-session.json' },
];
const headers = {};
if (process.env.OPENCODE_SERVER_PASSWORD) {
  headers.Authorization = `Basic ${Buffer.from(`${process.env.OPENCODE_SERVER_USERNAME || 'opencode'}:${process.env.OPENCODE_SERVER_PASSWORD}`).toString('base64')}`;
}

async function getHistory(url, timeout = 60000, authHeaders = {}) {
  const response = await fetch(url, { headers: authHeaders, signal: AbortSignal.timeout(timeout) });
  if (!response.ok) throw new Error(`History endpoint returned HTTP ${response.status}`);
  const text = await response.text();
  return { text, json: JSON.parse(text) };
}

// Acquire both complete OpenCode responses before creating any exports.
const histories = await Promise.all(targets.map(async target => {
  const url = new URL(`http://localhost:4096/session/${target.session_id}/message`);
  const history = await getHistory(url, 60000, headers);
  if (!Array.isArray(history.json) || !history.json.every(row => row.info && Array.isArray(row.parts))) {
    throw new Error(`Unexpected OpenCode message response for ${target.session_id}`);
  }
  return { ...target, ...history, source: url.href };
}));

let claudeEndpoint;
let claudeEndpointError;
try {
  claudeEndpoint = await getHistory('http://localhost:3284/messages', 5000);
  if (!Array.isArray(claudeEndpoint.json)) throw new Error('Expected a Claude messages array.');
} catch (error) {
  claudeEndpoint = undefined;
  claudeEndpointError = `${error.name}: ${error.message}`;
}

const journalDirectory = resolve(stateDir, 'requests');
const journal = [];
for (const name of await readdir(journalDirectory)) {
  if (!/^[0-9a-f-]{36}\.json$/i.test(name)) continue;
  const record = JSON.parse(await readFile(resolve(journalDirectory, name), 'utf8'));
  journal.push(record);
}
journal.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)) || a.request_id.localeCompare(b.request_id));
const claudeRecords = journal.filter(record => record.target_provider === 'claude' || record.sender?.provider === 'claude');
const claudeMessages = claudeRecords.flatMap(record => {
  const messages = [{
    role: 'user', request_id: record.request_id, timestamp: record.created_at,
    sender: record.sender, target_provider: record.target_provider,
    target_session_id: record.session_id, content: record.message,
  }];
  if (typeof record.reply === 'string') messages.push({
    role: 'assistant', request_id: record.request_id,
    timestamp: record.updated_at ?? null, timestamp_note: 'Request update time, not an independently observed message timestamp.',
    sender: record.receiver ?? { provider: record.target_provider },
    content: record.reply, request_status: record.status,
  });
  return messages;
});
const claudeExport = claudeEndpoint ? claudeEndpoint.text : JSON.stringify({
  export_type: 'openbridge_claude_conversation_snapshot', captured_at: capturedAt,
  requested_endpoint: 'http://localhost:3284/messages', requested_endpoint_available: false,
  endpoint_error: claudeEndpointError,
  source: '.openbridge/requests/*.json',
  coverage: 'All available project-local journal records involving Claude, in both directions. This is not the full native Claude terminal transcript. It excludes unjournaled terminal interactions, thinking, and native tool execution details.',
  messages: claudeMessages, requests: claudeRecords,
}, null, 2);

await mkdir(output, { recursive: true });
const exports = [];
async function save(name, text, metadata) {
  const path = resolve(output, name);
  await writeFile(path, text, { flag: 'wx', mode: 0o600 });
  const bytes = await readFile(path);
  JSON.parse(bytes.toString('utf8'));
  exports.push({ file: name, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), ...metadata });
}
for (const history of histories) {
  await save(history.file, history.text, {
    source: history.source, session_id: history.session_id,
    messages: history.json.length,
    parts: history.json.reduce((count, row) => count + row.parts.length, 0),
    coverage: 'Unmodified JSON returned by the requested OpenCode message-history endpoint, with no limit parameter.',
  });
}
await save('claude-sonnet-session.json', claudeExport, {
  source: claudeEndpoint ? 'http://localhost:3284/messages' : '.openbridge/requests/*.json',
  messages: claudeEndpoint ? claudeEndpoint.json.length : claudeMessages.length,
  request_records: claudeEndpoint ? undefined : claudeRecords.length,
  coverage: claudeEndpoint ? 'Unmodified JSON returned by the Claude HTTP messages endpoint.' : 'Project-local bridge conversations involving Claude; not a full native terminal transcript.',
});
await save('openbridge-request-journal.json', JSON.stringify({ captured_at: capturedAt, requests: journal }, null, 2), {
  source: '.openbridge/requests/*.json', request_records: journal.length,
  coverage: 'All available project-local request records, including statuses, metadata, relayed prompts and available replies.',
});
const manifest = {
  captured_at: capturedAt, directory: output, exports,
  notes: [
    'Snapshot only. Requests pending during capture may finish later; this export is not a live log.',
    'The orchestrator export contains the user request initiating this export, but cannot contain the future completion message reporting that the export succeeded.',
    'Port 3284 belongs to the optional AgentAPI/agent-http approach. Our actual Claude integration uses the project broker and native MCP channel.',
    'Bridge credentials and .openbridge/config.json were not exported.',
  ],
};
await writeFile(resolve(output, 'export-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
console.log(JSON.stringify(manifest, null, 2));
