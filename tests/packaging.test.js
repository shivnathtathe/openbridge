import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readdir, readFile, writeFile, rm, access } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const repository = fileURLToPath(new URL('../', import.meta.url));
const quotePS = value => `'${value.replaceAll("'", "''")}'`;

async function run(program, args, cwd, env) {
  const child = spawn(program, args, { cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const output = [];
  const errors = [];
  child.stdout.on('data', chunk => output.push(chunk));
  child.stderr.on('data', chunk => errors.push(chunk));
  const code = await new Promise((done, reject) => { child.once('error', reject); child.once('exit', done); });
  assert.equal(code, 0, `${program} failed: ${Buffer.concat(errors).toString()}`);
  return Buffer.concat(output).toString();
}

function npm(args, cwd, env) {
  return process.platform === 'win32'
    ? run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `& npm ${args.map(quotePS).join(' ')}; exit $LASTEXITCODE`], cwd, env)
    : run('npm', args, cwd, env);
}

test('npm archive includes only runtime files and initializes the consumer workspace', { timeout: 120000 }, async t => {
  const temp = await mkdtemp(resolve(repository, '.openbridge-package-test-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const env = { ...process.env };
  // Match a new user's shell rather than inheriting this live bridge's project.
  delete env.OPENBRIDGE_PROJECT;
  delete env.OPENCODE_DIRECTORY;
  delete env.OPENBRIDGE_SESSION_ID;
  delete env.INIT_CWD;
  for (const key of Object.keys(env)) if (/^npm_/i.test(key)) delete env[key];

  const [pack] = JSON.parse(await npm(['pack', '--ignore-scripts', '--json', '--pack-destination', temp], repository, env));
  const manifest = JSON.parse(await readFile(resolve(repository, 'package.json'), 'utf8'));
  const sourceFiles = (await readdir(resolve(repository, 'src'), { recursive: true }))
    .filter(file => file.endsWith('.js')).map(file => `src/${file.split(sep).join('/')}`);
  const expected = [...sourceFiles, 'assets/logo.png', 'assets/white_logo.png', 'README.md', 'package.json'].sort();
  assert.deepEqual(pack.files.map(file => file.path).sort(), expected);
  assert.ok(!pack.files.some(file => /hisotry_conco|\.openbridge\/|opencode\.json|\.test\.js|DEVELOPMENT_STORY/.test(file.path)));

  const consumer = resolve(temp, 'consumer project with spaces');
  await mkdir(consumer);
  // Without a package boundary, npm walks up to this repository's manifest.
  await writeFile(resolve(consumer, 'package.json'), JSON.stringify({ name: 'openbridge-install-test', private: true }));
  // Use npm's real tarball installation and command shim, without dependency
  // lifecycle scripts or model/network-service startup. Dependency metadata may
  // be fetched, so a clean CI cache is supported as well as a warm local cache.
  await npm(['install', '--prefix', consumer, '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=false', resolve(temp, pack.filename)], consumer, env);
  const result = await npm(['exec', '--prefix', consumer, '--offline', '--', 'openbridge', 'init'], consumer, env);
  assert.match(result, /OpenBridge configured/);
  const config = JSON.parse(await readFile(resolve(consumer, '.openbridge', 'config.json'), 'utf8'));
  assert.equal(config.token.length, 64);
  const clientConfig = JSON.parse(await readFile(resolve(consumer, 'opencode.json'), 'utf8'));
  assert.equal(clientConfig.mcp.session_bridge.environment.OPENBRIDGE_PROJECT, consumer);
  assert.equal(clientConfig.mcp.session_bridge.command[1], resolve(consumer, 'node_modules', manifest.name, 'src', 'mcp', 'server.js'));
  await assert.rejects(access(resolve(consumer, 'node_modules', manifest.name, '.openbridge')), { code: 'ENOENT' });

  // Upgrades refresh cached channel paths without replacing native IDs or tokens.
  const claudeConfigPath = resolve(consumer, '.openbridge', `claude-${config.claude_sessions[0].session_id}.mcp.json`);
  await writeFile(claudeConfigPath, JSON.stringify({ mcpServers: { openbridge: { command: 'node', args: ['old-root-channel.js'] } } }));
  clientConfig.mcp.custom_user_server = { type: 'local', command: ['example'], enabled: false };
  await writeFile(resolve(consumer, 'opencode.json'), JSON.stringify(clientConfig));
  await npm(['exec', '--prefix', consumer, '--offline', '--', 'openbridge', 'init'], consumer, env);
  const migrated = JSON.parse(await readFile(claudeConfigPath, 'utf8'));
  assert.equal(migrated.mcpServers.openbridge.args[0], resolve(consumer, 'node_modules', manifest.name, 'src', 'claude', 'channel.js'));
  assert.equal(migrated.mcpServers.openbridge.env.OPENBRIDGE_SESSION_ID, config.claude_sessions[0].session_id);
  const preserved = JSON.parse(await readFile(resolve(consumer, '.openbridge', 'config.json'), 'utf8'));
  assert.equal(preserved.token, config.token);
  assert.equal(preserved.layout_version, 2);
  const updatedClient = JSON.parse(await readFile(resolve(consumer, 'opencode.json'), 'utf8'));
  assert.deepEqual(updatedClient.mcp.custom_user_server, clientConfig.mcp.custom_user_server);

  // Explicit workspace selection still overrides the shell's current directory.
  const probe = await run(process.execPath, ['--input-type=module', '-e', `import {root} from ${JSON.stringify(new URL('../src/core/runtime.js', import.meta.url).href)}; console.log(root);`], consumer, { ...env, OPENBRIDGE_PROJECT: repository });
  assert.equal(probe.trim(), resolve(repository));
});
