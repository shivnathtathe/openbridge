import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { test } from 'node:test';
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

test('cross-application bridge integration', async t => {
  const project = await mkdtemp(resolve('.openbridge-test-'));
  process.env.OPENBRIDGE_PROJECT = project;
  const { startBroker } = await import('../src/broker/server.js');
  const { brokerFetch, ensureBroker, initialize, atomicJson, configPath } = await import('../src/core/runtime.js');
  t.after(() => rm(project, { recursive: true, force: true }));
  const messages = [];
  const mock = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    res.setHeader('Content-Type', 'application/json');
    if (url.pathname === '/global/health') return res.end('{"healthy":true}');
    if (url.pathname === '/session/status') return res.end('{}');
    if (url.pathname === '/session') return res.end(JSON.stringify([
      { id: 'ses_source', title: 'GPT source', directory: project, model: { id: 'gpt-test', providerID: 'openai' } },
      { id: 'ses_target', title: 'GPT target', directory: project, model: { id: 'gpt-review', providerID: 'openai' } },
      { id: 'ses_outside', directory: 'some-other-project' },
    ]));
    if (url.pathname === '/session/ses_source') return res.end(JSON.stringify({ model: { id: 'gpt-test', providerID: 'openai' } }));
    if (url.pathname.endsWith('/message')) {
      messages.push(JSON.parse(Buffer.concat(chunks).toString()));
      return res.end(JSON.stringify({ info: { id: 'msg_test', role: 'assistant', modelID: 'gpt-review', providerID: 'openai' }, parts: [{ type: 'text', text: 'Reviewed by OpenCode.' }] }));
    }
    res.writeHead(404); res.end('{}');
  });
  await new Promise(done => mock.listen(0, '127.0.0.1', done));
  t.after(() => { mock.closeAllConnections(); mock.close(); });
  // Reserve then release a test port; broker readiness/identity is checked over HTTP.
  const portProbe = createServer();
  await new Promise(done => portProbe.listen(0, '127.0.0.1', done));
  const port = portProbe.address().port;
  await new Promise(done => portProbe.close(done));
  const config = await initialize();
  config.broker_url = `http://127.0.0.1:${port}`;
  config.opencode.url = `http://127.0.0.1:${mock.address().port}`;
  config.request_timeout_ms = 1000;
  config.claude_sessions[0].auto_start = false;
  await atomicJson(configPath, config);
  let broker = await startBroker(config);
  t.after(() => broker.close());

  const connect = async (file, env = {}) => {
    const client = new Client({ name: 'integration-test', version: '1' });
    const transport = new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL(file, import.meta.url))], env: { ...process.env, OPENBRIDGE_PROJECT: project, ...env }, stderr: 'pipe' });
    await client.connect(transport);
    t.after(() => client.close());
    return client;
  };
  const source = await connect('../src/mcp/server.js');
  const call = (client, name, args) => client.callTool({ name, arguments: args });
  const sourceFields = { provider: 'opencode', model: 'caller-claimed-model', source_session_id: 'ses_source' };
  const claudeId = config.claude_sessions[0].session_id;

  await t.test('discovery includes exact native IDs, names, provider and model', async () => {
    const result = await call(source, 'list_sessions', {});
    const { sessions } = result.structuredContent;
    assert.equal(sessions.length, 3);
    assert.deepEqual(sessions.find(s => s.session_id === 'ses_source'), {
      session_id: 'ses_source', name: 'GPT source', provider: 'opencode', model_provider: 'openai', model: 'gpt-test', status: 'idle', reachable: true, metadata_source: 'opencode_api',
    });
    assert.equal(sessions.find(s => s.session_id === claudeId).status, 'offline');
    assert.ok(!sessions.some(s => s.session_id === 'ses_outside'));
  });

  await t.test('OpenCode forwarding contains verified sender application/model', async () => {
    const result = await call(source, 'ask_opencode', { session_id: 'ses_target', message: 'Review this', ...sourceFields });
    assert.equal(result.structuredContent.status, 'completed');
    assert.equal(result.structuredContent.reply, 'Reviewed by OpenCode.');
    const text = messages.at(-1).parts[0].text;
    assert.match(text, /"provider":"opencode"/);
    assert.match(text, /"model":"gpt-test"/);
    assert.doesNotMatch(text, /caller-claimed-model/);
  });

  const channel = await connect('../src/claude/channel.js', { OPENBRIDGE_SESSION_ID: claudeId, OPENBRIDGE_SESSION_NAME: 'Claude reviewer', OPENBRIDGE_SESSION_MODEL: 'sonnet' });
  const notifications = [];
  channel.setNotificationHandler(z.object({ method: z.literal('notifications/claude/channel'), params: z.object({ content: z.string(), meta: z.record(z.string(), z.string()) }) }), notification => { notifications.push(notification.params); });
  const waitFor = async predicate => {
    for (let i = 0; i < 100; i++) { if (await predicate()) return; await sleep(50); }
    throw new Error('Timed out waiting for test condition');
  };
  await waitFor(async () => (await brokerFetch(config, '/sessions')).sessions.some(s => s.session_id === claudeId && s.reachable));

  await t.test('native channel round trip with sender metadata and circular wait prevention', async () => {
    const pending = call(source, 'ask_claude', { session_id: claudeId, message: 'Hello Claude', ...sourceFields });
    await waitFor(() => notifications.length > 0);
    const inbound = notifications.at(-1);
    assert.match(inbound.content, /Hello Claude/);
    assert.equal(inbound.meta.provider, 'opencode');
    assert.equal(inbound.meta.model, 'gpt-test');
    const cycle = await call(channel, 'ask_opencode', { session_id: 'ses_source', message: 'Call back', provider: 'claude', model: 'sonnet' });
    assert.equal(cycle.isError, true);
    assert.match(cycle.content[0].text, /Circular wait/);
    const reply = await call(channel, 'bridge_reply', { request_id: inbound.meta.request_id, text: 'Hello GPT, from Claude.', final: true });
    assert.ok(!reply.isError);
    const result = (await pending).structuredContent;
    assert.equal(result.status, 'completed');
    assert.equal(result.reply, 'Hello GPT, from Claude.');
    assert.equal(result.receiver.provider, 'claude');
    assert.equal(result.request_id, inbound.meta.request_id);
  });

  await t.test('late replies, duplicate IDs and per-target concurrency', async () => {
    const before = notifications.length;
    const first = call(source, 'ask_claude', { session_id: claudeId, message: 'Take your time', ...sourceFields });
    await waitFor(() => notifications.length > before);
    const inbound = notifications.at(-1);
    const duplicate = await call(source, 'ask_claude', { session_id: claudeId, message: 'Another request', ...sourceFields });
    assert.equal(duplicate.isError, true);
    assert.match(duplicate.content[0].text, /pending or uncertain/);
    const timed = (await first).structuredContent;
    assert.equal(timed.wait_timed_out, true);
    assert.equal(timed.status, 'pending');
    const replay = await brokerFetch(config, '/ask', { request_id: inbound.meta.request_id, target_provider: 'claude', session_id: claudeId, message: 'Take your time', ...sourceFields });
    assert.equal(replay.request_id, timed.request_id);
    assert.equal(notifications.length, before + 1);
    await call(channel, 'bridge_reply', { request_id: inbound.meta.request_id, text: 'Late answer', final: true });
    const retrieved = await call(source, 'get_request', { request_id: timed.request_id });
    assert.equal(retrieved.structuredContent.reply, 'Late answer');
    assert.equal(retrieved.structuredContent.status, 'completed');
  });

  await t.test('Claude can initiate OpenCode conversation with its own identity', async () => {
    const result = await call(channel, 'ask_opencode', { session_id: 'ses_target', message: 'Review for me', provider: 'claude', model: 'sonnet' });
    assert.equal(result.structuredContent.status, 'completed');
    assert.match(messages.at(-1).parts[0].text, /"provider":"claude"/);
    assert.match(messages.at(-1).parts[0].text, new RegExp(claudeId));
  });

  await t.test('unauthenticated HTTP and unknown replies are rejected', async () => {
    const unauthorized = await fetch(`${config.broker_url}/sessions`);
    assert.equal(unauthorized.status, 401);
    const unknown = await call(channel, 'bridge_reply', { request_id: randomUUID(), text: 'wrong reply', final: true });
    assert.equal(unknown.isError, true);
    const browser = await fetch(`${config.broker_url}/health`, { headers: { Authorization: `Bearer ${config.token}`, Origin: 'http://example.com' } });
    assert.equal(browser.status, 403);
  });

  await t.test('older running brokers are rejected rather than silently reused', async () => {
    const legacy = createServer((req, res) => {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ service: 'openbridge', version: '2.0.0' }));
    });
    await new Promise(done => legacy.listen(0, '127.0.0.1', done));
    try {
      await assert.rejects(ensureBroker({ ...config, broker_url: `http://127.0.0.1:${legacy.address().port}` }), { code: 'BROKER_RESTART_REQUIRED' });
    } finally { legacy.closeAllConnections(); await new Promise(done => legacy.close(done)); }
  });

  await channel.close();
  await source.close();
  await broker.close();
  await t.test('restart marks interrupted requests uncertain and blocks silent resending', async () => {
    const id = randomUUID();
    await mkdir(resolve(project, '.openbridge', 'requests'), { recursive: true });
    await writeFile(resolve(project, '.openbridge', 'requests', `${id}.json`), JSON.stringify({ request_id: id, target_provider: 'claude', session_id: claudeId, status: 'pending', message: 'interrupted', sender: { provider: 'opencode' }, delivery: 'channel_notification_started' }));
    broker = await startBroker(config);
    const result = await brokerFetch(config, `/requests/${id}`);
    assert.equal(result.status, 'unknown');
    await assert.rejects(brokerFetch(config, '/ask', { request_id: randomUUID(), target_provider: 'claude', session_id: claudeId, message: 'do not duplicate', ...sourceFields }), /uncertain/);
    await brokerFetch(config, '/release', { request_id: id, confirm_target_is_idle: true });
    assert.equal((await brokerFetch(config, `/requests/${id}`)).status, 'released');
  });
  await broker.close();
  await t.test('missing OpenCode starts once and healthy server is reused', async () => {
    let running = false;
    let launches = 0;
    broker = await startBroker(config, {
      fetch: async url => {
        if (!running) throw new TypeError('connection refused');
        const path = new URL(url).pathname;
        return Response.json(path === '/global/health' ? { healthy: true } : path === '/session' ? [] : {});
      },
      launch: async () => { launches++; running = true; },
    });
    const [one, two] = await Promise.all([brokerFetch(config, '/sessions'), brokerFetch(config, '/sessions')]);
    assert.equal(one.services.opencode.status, 'healthy');
    assert.equal(two.services.opencode.status, 'healthy');
    assert.equal(launches, 1);
    await brokerFetch(config, '/sessions');
    assert.equal(launches, 1);
  });
});
