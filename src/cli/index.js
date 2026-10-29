#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { atomicJson, configPath, brokerFetch, ensureBroker, initialize, loadConfig, root, entrypoints, stateDir } from '../core/runtime.js';
import { writeClaudeConfig } from '../claude/config.js';

const args = process.argv.slice(2);
const option = name => args[args.indexOf(name) + 1];
const quotePS = value => `'${value.replaceAll("'", "''")}'`;
async function spawned(command, argv, options) {
  const child = spawn(command, argv, options);
  await new Promise((done, reject) => { child.once('spawn', done); child.once('error', reject); });
  return child;
}

try {
  switch (args[0]) {
    case 'init': {
      const config = await initialize();
      // Standard JSON only: never rewrite a JSONC configuration as plain JSON.
      const path = resolve(root, 'opencode.json');
      let existing = {};
      try { existing = JSON.parse(await readFile(path, 'utf8')); }
      catch (error) { if (error.code !== 'ENOENT') throw new Error('Cannot merge opencode.json: expected valid JSON. No file was overwritten.'); }
      existing.$schema ||= 'https://opencode.ai/config.json';
      existing.mcp ||= {};
      existing.mcp.session_bridge = {
        ...existing.mcp.session_bridge,
        type: 'local', command: [process.execPath, entrypoints.server], enabled: true,
        timeout: config.request_timeout_ms + 30000,
        environment: { ...existing.mcp.session_bridge?.environment, OPENBRIDGE_PROJECT: root },
      };
      if (Object.keys(existing).length) {
        try { await writeFile(resolve(stateDir, 'opencode.initial-backup.json'), await readFile(path), { flag: 'wx', mode: 0o600 }); }
        catch (error) { if (!['ENOENT', 'EEXIST'].includes(error.code)) throw error; }
      }
      // Refresh all managed paths before switching the client entrypoint.
      for (const session of config.claude_sessions) await writeClaudeConfig(session);
      await atomicJson(configPath, { ...config, layout_version: 2 });
      await atomicJson(path, existing);
      console.log(`OpenBridge configured in ${root}\nClaude session ID: ${config.claude_sessions[0]?.session_id}\nRestart OpenCode to load ask_opencode, ask_claude, list_sessions, get_request.\nRun openbridge claude for first-time Claude login/trust/channel consent. Subsequent ask_claude calls can open its terminal automatically.`);
      break;
    }
    case 'sessions':
    case 'doctor': {
      const config = await loadConfig();
      await ensureBroker(config);
      console.log(JSON.stringify(await brokerFetch(config, args[0] === 'sessions' ? '/sessions' : '/health', undefined, AbortSignal.timeout(25000)), null, 2));
      break;
    }
    case 'release': {
      if (!args.includes('--confirm-target-is-idle')) throw new Error('Inspect the target first, then use: openbridge release REQUEST_ID --confirm-target-is-idle');
      const config = await loadConfig();
      await ensureBroker(config);
      console.log(JSON.stringify(await brokerFetch(config, '/release', { request_id: args[1], confirm_target_is_idle: true }), null, 2));
      break;
    }
    case 'claude': {
      const config = await loadConfig();
      const id = args.includes('--session') ? option('--session') : config.claude_sessions[0]?.session_id;
      const session = config.claude_sessions.find(s => s.session_id === id);
      if (!session) throw new Error('Choose a configured Claude session ID from openbridge sessions.');
      await ensureBroker(config);
      if (args.includes('--window')) {
        const argv = [entrypoints.cli, 'claude', '--session', id];
        if (process.platform === 'win32') {
          // Start-Process gives Claude a real terminal for consent and permissions.
          const argumentLine = argv.map(a => `"${a.replaceAll('"', '\\"')}"`).join(' ');
          const code = `Start-Process -FilePath ${quotePS(process.execPath)} -ArgumentList ${quotePS(argumentLine)} -WorkingDirectory ${quotePS(root)}`;
          const child = await spawned('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(code, 'utf16le').toString('base64')], { stdio: 'ignore', windowsHide: true });
          await new Promise((done, reject) => child.once('exit', code => code === 0 ? done() : reject(new Error(`Terminal launcher exited ${code}`))));
        } else {
          const command = process.platform === 'darwin' ? null : 'x-terminal-emulator';
          if (!command) throw new Error('Automatic terminal opening is currently implemented for Windows and Linux with x-terminal-emulator. Run openbridge claude in your macOS terminal.');
          const child = await spawned(command, ['-e', process.execPath, ...argv], { cwd: root, detached: true, stdio: 'ignore' });
          child.unref();
        }
        break;
      }
      const mcpPath = await writeClaudeConfig(session);
      const marker = resolve(stateDir, `claude-${id}.started`);
      let resume = false;
      try { await readFile(marker); resume = true; } catch (error) { if (error.code !== 'ENOENT') throw error; }
      const command = session.command || 'claude';
      const argv = [resume ? '--resume' : '--session-id', id, '--name', session.name, '--model', session.model, '--mcp-config', mcpPath, '--dangerously-load-development-channels', 'server:openbridge'];
      console.log(`Starting ${session.name} (${id}). Complete any Claude login, trust or channel prompts.\nIf a previous first launch never created its session, remove ${marker} and launch again.`);
      const child = await spawned(command, argv, { cwd: root, stdio: 'inherit', env: { ...process.env, OPENBRIDGE_PROJECT: root, OPENBRIDGE_SESSION_ID: id, MCP_PROTOCOL_NEGOTIATION: 'legacy' } });
      await writeFile(marker, id, { mode: 0o600 });
      process.exitCode = await new Promise(done => child.once('exit', code => done(code ?? 1)));
      break;
    }
    default:
      console.log('Usage: openbridge init | doctor | sessions | claude [--session UUID] [--window] | release REQUEST_ID --confirm-target-is-idle');
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }
