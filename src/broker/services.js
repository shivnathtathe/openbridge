import { open } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { root, stateDir, entrypoints } from '../core/runtime.js';
import { object } from '../core/validation.js';

/** Upstream health, managed startup and project-scoped discovery. */
export function createServices(config, channels, busy, dependencies = {}) {
  const launching = new Map();
  const fetcher = dependencies.fetch || fetch;
  const configured = id => config.claude_sessions.find(s => s.session_id === id);

  async function api(path, signal = AbortSignal.timeout(2000)) {
    const url = new URL(config.opencode.url);
    url.pathname = `${url.pathname.replace(/\/$/, '')}${path}`;
    url.searchParams.set('directory', root);
    const headers = {};
    if (process.env.OPENCODE_SERVER_PASSWORD) headers.Authorization = `Basic ${Buffer.from(`${process.env.OPENCODE_SERVER_USERNAME || 'opencode'}:${process.env.OPENCODE_SERVER_PASSWORD}`).toString('base64')}`;
    const response = await fetcher(url, { headers, signal });
    if (!response.ok) throw new Error(`OpenCode HTTP ${response.status}`);
    return response.json();
  }

  async function launch(command, logName) {
    if (!Array.isArray(command) || !command.length || command.some(value => typeof value !== 'string')) throw new Error('Invalid startup command array.');
    if (dependencies.launch) return dependencies.launch(command);
    const log = await open(resolve(stateDir, logName), 'a', 0o600);
    try {
      // Resolve Windows npm shims through PowerShell; prompts never enter this command.
      const quote = value => `'${value.replaceAll("'", "''")}'`;
      const program = process.platform === 'win32' ? 'powershell.exe' : command[0];
      const args = process.platform === 'win32'
        ? ['-NoProfile', '-NonInteractive', '-Command', `& ${command.map(quote).join(' ')}; exit $LASTEXITCODE`]
        : command.slice(1);
      const child = spawn(program, args, { cwd: root, env: process.env, detached: true, windowsHide: true, stdio: ['ignore', log.fd, log.fd] });
      await new Promise((done, reject) => { child.once('spawn', done); child.once('error', reject); });
      child.unref();
    } finally { await log.close(); }
  }

  function rememberLaunch(key, pending) {
    launching.set(key, pending);
    pending.then(() => launching.delete(key), () => {
      const timer = setTimeout(() => launching.delete(key), 60000);
      timer.unref();
    });
    return pending;
  }

  async function ensureOpenCode() {
    try {
      if ((await api('/global/health'))?.healthy !== true) throw new Error('Unexpected OpenCode health response.');
      return;
    } catch (error) {
      if (!error.cause && error.name !== 'TimeoutError' && !(error instanceof TypeError)) throw error;
    }
    if (!config.opencode.auto_start) throw new Error('OpenCode is offline and auto_start is disabled.');
    if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(config.opencode.url).hostname)) throw new Error('Cannot auto-start a non-local OpenCode server.');
    if (launching.has('opencode')) return launching.get('opencode');
    return rememberLaunch('opencode', (async () => {
      await launch(config.opencode.command, 'opencode.log');
      for (let attempt = 0; attempt < 40; attempt++) {
        try { if ((await api('/global/health'))?.healthy) return; } catch { /* bounded readiness polling */ }
        await sleep(250);
      }
      throw new Error('OpenCode startup did not become healthy. Check .openbridge/opencode.log.');
    })());
  }

  function live(id) {
    const channel = channels.get(id);
    return channel && Date.now() - channel.last_seen < 15000 ? channel : undefined;
  }

  async function ensureClaude(id) {
    if (live(id)) return live(id);
    const session = configured(id);
    if (!session) throw new Error('Claude session is not connected or configured in this project. Select an exact ID from list_sessions.');
    if (!session.auto_start) throw new Error('Claude session is offline and auto_start is disabled.');
    if (!launching.has(id)) rememberLaunch(id, (async () => {
      if (dependencies.startClaude) await dependencies.startClaude(id);
      else await launch([process.execPath, entrypoints.cli, 'claude', '--session', id, '--window'], `claude-${id}.log`);
      for (let attempt = 0; attempt < 40; attempt++) {
        if (live(id)) return live(id);
        await sleep(250);
      }
      throw new Error('Claude launch requested but channel is not connected. Complete login, workspace trust, and development-channel consent in its terminal. No prompt has been delivered.');
    })());
    await launching.get(id);
    const channel = live(id);
    if (!channel) throw new Error('Claude channel is offline.');
    return channel;
  }

  async function listSessions() {
    const sessions = [];
    const services = {};
    try {
      await ensureOpenCode();
      const [rows, statuses] = await Promise.all([api('/session'), api('/session/status')]);
      if (!Array.isArray(rows) || !object(statuses)) throw new Error('Unexpected OpenCode session inventory.');
      services.opencode = { status: 'healthy' };
      for (const row of rows) {
        if (row.directory !== root) continue;
        sessions.push({ session_id: row.id, name: row.title ?? null, provider: 'opencode', model_provider: row.model?.providerID ?? null, model: row.model?.id ?? row.model?.modelID ?? null, status: statuses[row.id]?.type || 'idle', reachable: true, metadata_source: 'opencode_api' });
      }
    } catch (error) { services.opencode = { status: 'unavailable', error: error.message }; }
    const ids = new Set([...config.claude_sessions.map(s => s.session_id), ...channels.keys()]);
    for (const id of ids) {
      const channel = live(id);
      const session = channel?.metadata || configured(id) || channels.get(id)?.metadata;
      sessions.push({ session_id: id, name: session.name, provider: 'claude', model_provider: null, model: session.model || null, status: channel ? (busy.has(`claude:${id}`) ? 'busy' : 'channel_connected') : 'offline', reachable: !!channel, auto_start: !!configured(id)?.auto_start, metadata_source: 'launch_configuration', delivery_confirmed: channel?.delivery_confirmed || false });
    }
    services.claude = { status: sessions.some(s => s.provider === 'claude' && s.reachable) ? 'connected' : 'not_connected', note: 'Lists project channel connections/configured targets, not arbitrary Claude history. Model and name are launch settings, not live /model or /rename observations.' };
    return { sessions, services };
  }

  return { api, live, ensureOpenCode, ensureClaude, listSessions };
}
