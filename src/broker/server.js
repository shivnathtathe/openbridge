import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { loadConfig, root, entrypoints, BROKER_PROTOCOL_VERSION } from '../core/runtime.js';
import { UUID, object, text } from '../core/validation.js';
import { openJournal } from './journal.js';
import { createServices } from './services.js';
import { createRequests } from './requests.js';

/** HTTP composition. Service lifecycle, coordination and storage stay independent. */
export async function startBroker(config, dependencies = {}) {
  const journal = await openJournal();
  const { records: requests, busy, persist } = journal;
  const channels = new Map();
  const services = createServices(config, channels, busy, dependencies);
  const coordinator = createRequests(config, journal, services);
  const { live } = services;
  const { ask, finish } = coordinator;

  const server = createServer(async (req, res) => {
    const json = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); };
    try {
      const supplied = Buffer.from(req.headers.authorization || '');
      const expected = Buffer.from(`Bearer ${config.token}`);
      if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return json(401, { error: 'Unauthorized' });
      if (req.headers.origin) return json(403, { error: 'Browser-origin requests are not accepted.' });
      const url = new URL(req.url, 'http://127.0.0.1');
      let body = {};
      if (req.method === 'POST') {
        let size = 0;
        const chunks = [];
        for await (const chunk of req) {
          size += chunk.length;
          if (size > 512000) return json(413, { error: 'Request too large.' });
          chunks.push(chunk);
        }
        body = JSON.parse(Buffer.concat(chunks).toString());
        if (!object(body)) throw new Error('Expected a JSON object.');
      }
      if (req.method === 'GET' && url.pathname === '/health') return json(200, { service: 'openbridge', version: '2.0.0', protocol_version: BROKER_PROTOCOL_VERSION, project_root: root });
      if (req.method === 'GET' && url.pathname === '/sessions') return json(200, await services.listSessions());
      if (req.method === 'GET' && url.pathname.startsWith('/requests/')) {
        const record = requests.get(url.pathname.slice('/requests/'.length));
        return json(record ? 200 : 404, record || { error: 'Unknown request ID.' });
      }
      if (req.method === 'POST' && url.pathname === '/release') {
        const record = requests.get(body.request_id);
        if (!record || record.status !== 'unknown' || body.confirm_target_is_idle !== true) throw new Error('Only an unknown request can be released after explicitly confirming the target is idle.');
        await finish(record, 'released', { note: 'Caller explicitly confirmed the target is idle; no prompt was resent.' });
        return json(200, record);
      }
      if (req.method === 'POST' && url.pathname === '/ask') {
        const record = await ask(body);
        const deadline = Date.now() + config.request_timeout_ms;
        while (record.status === 'pending' && Date.now() < deadline && !res.destroyed) await sleep(100);
        return json(200, record.status === 'pending' ? { ...record, wait_timed_out: true, note: 'Still pending; do not resend. Use get_request.' } : record);
      }
      if (req.method === 'POST' && url.pathname === '/channel/register') {
        if (!UUID.test(body.session_id) || !UUID.test(body.connection_id) || !text(body.name, 200) || !text(body.model, 200)) throw new Error('Invalid channel registration.');
        const old = live(body.session_id);
        if (old && old.connection_id !== body.connection_id) throw new Error('Another live channel already owns this Claude session ID.');
        channels.set(body.session_id, { connection_id: body.connection_id, last_seen: Date.now(), metadata: { name: body.name, model: body.model }, delivery_confirmed: old?.delivery_confirmed || false });
        return json(200, { registered: true });
      }
      if (req.method === 'POST' && url.pathname.startsWith('/channel/')) {
        const channel = live(body.session_id);
        if (!channel || channel.connection_id !== body.connection_id) return json(409, { error: 'Channel registration expired; register again.' });
        channel.last_seen = Date.now();
        if (url.pathname === '/channel/next') {
          const record = [...requests.values()].find(record => record.target_provider === 'claude' && record.session_id === body.session_id && record.status === 'pending' && record.delivery === 'queued');
          if (!record) return json(200, { request: null });
          record.delivery = 'channel_notification_started';
          await persist(record);
          return json(200, { request: record });
        }
        if (url.pathname === '/channel/reply') {
          const record = requests.get(body.request_id);
          if (!record || record.session_id !== body.session_id || record.target_provider !== 'claude' || record.status !== 'pending') throw new Error('Unknown or completed channel request.');
          if (!text(body.text) || typeof body.final !== 'boolean') throw new Error('Invalid reply.');
          if ((record.reply?.length || 0) + body.text.length > 200000) throw new Error('Reply limit exceeded.');
          record.reply = [record.reply, body.text].filter(Boolean).join('\n\n');
          channel.delivery_confirmed = true;
          if (body.final) await finish(record, 'completed', { receiver: { provider: 'claude', model: channel.metadata.model, model_provider: null, metadata_source: 'launch_configuration' } });
          else await persist(record);
          return json(200, { accepted: true });
        }
        if (url.pathname === '/channel/close') {
          channels.delete(body.session_id);
          for (const record of requests.values()) if (record.target_provider === 'claude' && record.session_id === body.session_id && record.status === 'pending') await finish(record, record.delivery === 'not_sent' ? 'failed' : 'unknown', { error: 'Claude channel disconnected; execution state is unknown.' });
          return json(200, { closed: true });
        }
      }
      json(404, { error: 'Unknown endpoint.' });
    } catch (error) { if (!res.headersSent) json(400, { error: error.message }); }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  await new Promise((done, reject) => { server.once('error', reject); server.listen(Number(new URL(config.broker_url).port), '127.0.0.1', done); });
  let sweeping = false;
  const heartbeatTimer = setInterval(async () => {
    if (sweeping) return;
    sweeping = true;
    try {
      for (const record of requests.values()) {
        if (record.target_provider === 'claude' && record.status === 'pending' && ['queued', 'channel_notification_started'].includes(record.delivery) && !live(record.session_id)) {
          await finish(record, 'unknown', { error: 'Claude channel heartbeat expired; delivery/execution is uncertain. Check the target before releasing or retrying.' });
        }
      }
    } catch (error) { console.error('Heartbeat journal error:', error.message); }
    finally { sweeping = false; }
  }, 5000);
  heartbeatTimer.unref();
  return { server, requests, close: async () => { clearInterval(heartbeatTimer); server.closeAllConnections(); await new Promise(done => server.close(done)); await coordinator.drain(); } };
}

if (process.argv[1] && resolve(process.argv[1]) === entrypoints.broker) {
  startBroker(await loadConfig()).then(() => console.error('OpenBridge broker ready.')).catch(error => { console.error(error.message); process.exitCode = 1; });
}
