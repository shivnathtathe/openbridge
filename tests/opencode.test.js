import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createBridge } from '../src/adapters/opencode.js';

test('MCP discovery and HTTP round trip, validation, busy and error handling', async t => {
  const requests = [];
  let statuses = {};
  const http = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString();
    requests.push({ path: url.pathname, directory: url.searchParams.get('directory'), body, auth: req.headers.authorization });
    res.setHeader('Content-Type', 'application/json');
    if (url.pathname === '/session/status') return res.end(JSON.stringify(statuses));
    if (url.pathname === '/session/ses_missing/message') {
      res.writeHead(404);
      return res.end('{}');
    }
    if (url.pathname === '/session/ses_slow/message') return;
    if (url.pathname === '/session/ses_null/message') return res.end('null');
    if (url.pathname === '/session/ses_error/message') {
      return res.end(JSON.stringify({ info: { error: { name: 'ProviderAuthError' } } }));
    }
    res.end(JSON.stringify({
      info: { id: 'msg_reply', role: 'assistant', providerID: 'test', modelID: 'other-model' },
      parts: [{ type: 'reasoning', text: 'private reasoning' }, { type: 'text', text: 'Hello from B!' }, { type: 'text', text: 'Second paragraph.' }],
    }));
  });
  await new Promise(resolve => http.listen(0, '127.0.0.1', resolve));
  t.after(() => { http.closeAllConnections(); http.close(); });
  const env = {
    ...process.env,
    OPENCODE_BASE_URL: `http://127.0.0.1:${http.address().port}`,
    OPENCODE_DIRECTORY: 'C:\\project with spaces',
    OPENCODE_SERVER_USERNAME: 'test-user',
    OPENCODE_SERVER_PASSWORD: 'test-password',
    OPENCODE_CALLER_SESSION_ID: 'ses_caller',
    // First-request fetch setup can be slow while the package-install test runs.
    // Keep normal transport checks separate from the deliberate short deadline below.
    ASK_OTHER_TIMEOUT_MS: '5000',
  };
  const transport = new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('../src/mcp/server.js', import.meta.url))], env, stderr: 'pipe' });
  const client = new Client({ name: 'bridge-test', version: '1.0.0' });
  t.after(() => client.close());
  await client.connect(transport);
  const tools = await client.listTools();
  assert.deepEqual(tools.tools.map(tool => tool.name).sort(), ['ask_claude', 'ask_opencode', 'ask_other', 'get_request', 'list_sessions'].sort());
  const ask = (id, message = 'Hello "B"\nUnicode: नमस्ते') => client.callTool({ name: 'ask_other', arguments: { session_id: id, message } });
  const result = await ask('ses_target');
  assert.ok(!result.isError, JSON.stringify(result));
  assert.equal(result.structuredContent.reply, 'Hello from B!\n\nSecond paragraph.');
  assert.equal(result.structuredContent.model, 'other-model');
  const sent = requests.find(req => req.path === '/session/ses_target/message');
  assert.deepEqual(JSON.parse(sent.body), { parts: [{ type: 'text', text: 'Hello "B"\nUnicode: नमस्ते' }] });
  assert.equal(sent.directory, env.OPENCODE_DIRECTORY);
  assert.equal(sent.auth, `Basic ${Buffer.from('test-user:test-password').toString('base64')}`);

  statuses = { ses_busy: { type: 'busy' } };
  const busy = await ask('ses_busy');
  assert.equal(busy.isError, true);
  assert.match(busy.content[0].text, /busy/);
  assert.ok(!requests.some(req => req.path === '/session/ses_busy/message'));
  const self = await ask('ses_caller');
  assert.equal(self.isError, true);
  assert.match(self.content[0].text, /itself/);
  const invalid = await ask('../bad');
  assert.equal(invalid.isError, true);
  const blank = await ask('ses_target', '   ');
  assert.equal(blank.isError, true);
  const missing = await ask('ses_missing');
  assert.equal(missing.isError, true);
  assert.match(missing.content[0].text, /404/);
  const providerError = await ask('ses_error');
  assert.equal(providerError.isError, true);
  assert.match(providerError.content[0].text, /ProviderAuthError/);
  const malformed = await ask('ses_null');
  assert.equal(malformed.isError, true);
  assert.match(malformed.content[0].text, /unexpected assistant response/);
  const timeout = await ask('ses_slow');
  assert.equal(timeout.isError, true);
  assert.match(timeout.content[0].text, /Timed out.*may already have been accepted/);

  const bridge = createBridge({ ...env, ASK_OTHER_TIMEOUT_MS: '100' });
  await assert.rejects(bridge(null, 'test'), /Invalid OpenCode session_id/);
  await assert.rejects(bridge('ses_target', null), /message must not be blank/);
  const pending = bridge('ses_slow', 'first');
  await assert.rejects(bridge('ses_slow', 'second'), /already has a request pending/);
  await assert.rejects(pending, /Timed out/);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(bridge('ses_target', 'cancelled', controller.signal), /Request cancelled.*No prompt was submitted/);
});
