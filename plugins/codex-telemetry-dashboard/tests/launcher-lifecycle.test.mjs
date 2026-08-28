import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const testRoot = dirname(fileURLToPath(import.meta.url));
const launcherPath = join(testRoot, '..', 'scripts', 'launcher.mjs');
const launcherPowerShellPath = join(testRoot, '..', 'scripts', 'launcher.ps1');
const cliPath = join(testRoot, '..', 'scripts', 'cli.mjs');
const stopPath = join(testRoot, '..', 'scripts', 'stop.mjs');
const legacyServerPath = join(testRoot, 'fixtures', 'legacy-server.mjs');

function runNode(script, env, args = []) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [script, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('exit', (code) => code === 0 ? resolvePromise(JSON.parse(stdout)) : reject(new Error(stderr || `exit ${code}`)));
  });
}

function runPowerShell(script, env, args = []) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, ...args], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('exit', (code) => code === 0 ? resolvePromise(JSON.parse(stdout)) : reject(new Error(stderr || `exit ${code}`)));
  });
}

async function waitForRuntime(path, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { return JSON.parse(await readFile(path, 'utf8')); } catch { await new Promise((resolve) => setTimeout(resolve, 80)); }
  }
  throw new Error('runtime file was not created');
}

async function waitForExit(child, timeoutMs = 5000) {
  if (child.exitCode !== null) return;
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    new Promise((_, reject) => setTimeout(() => reject(new Error('process did not exit')), timeoutMs)),
  ]);
}

function spawnLegacy(env, rejectShutdown = false) {
  return spawn(process.execPath, [legacyServerPath], {
    env: { ...env, LEGACY_REJECT_SHUTDOWN: rejectShutdown ? '1' : '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
}

test('cross-platform Node launcher starts, reuses, and stops one detached service', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'codex-telemetry-launcher-'));
  const dataRoot = join(root, 'data');
  const codexHome = join(root, '.codex');
  await mkdir(join(codexHome, 'sessions'), { recursive: true });
  const env = { ...process.env, CODEX_TELEMETRY_DATA_DIR: dataRoot, CODEX_HOME: codexHome };
  let runtime = null;
  t.after(async () => {
    if (runtime) {
      try { process.kill(runtime.pid, 'SIGTERM'); } catch { /* already stopped */ }
    }
    await rm(root, { recursive: true, force: true });
  });

  const first = await runNode(launcherPath, env);
  runtime = JSON.parse(await readFile(join(dataRoot, 'runtime.json'), 'utf8'));
  const second = await runNode(launcherPath, env);
  assert.equal(first.reused, false);
  assert.equal(first.version, '1.4.0');
  assert.equal(second.reused, true);
  assert.equal(second.version, '1.4.0');
  assert.equal(second.pid, first.pid);
  assert.equal(runtime.version, '1.4.0');
  assert.equal(new URL(first.url).hostname, '127.0.0.1');
  assert.equal(first.accessMode, 'local');
  assert.deepEqual(first.urls, [first.url]);

  const lan = await runNode(launcherPath, env, ['--access=lan']);
  runtime = JSON.parse(await readFile(join(dataRoot, 'runtime.json'), 'utf8'));
  assert.equal(lan.reused, false, 'changing access mode restarts the service');
  assert.notEqual(lan.pid, first.pid);
  assert.equal(lan.accessMode, 'lan');
  assert.equal(runtime.host, '0.0.0.0');
  assert.equal(runtime.accessMode, 'lan');
  assert.equal(new URL(lan.url).hostname, '127.0.0.1');
  assert.ok(lan.urls.length >= 1);

  const reusedLan = await runNode(launcherPath, env, ['--access', 'lan']);
  assert.equal(reusedLan.reused, true);
  assert.equal(reusedLan.pid, lan.pid);

  const stopped = await runNode(stopPath, env);
  assert.equal(stopped.stopped, true);
  assert.equal(stopped.pid, lan.pid);
  runtime = null;
});

test('Windows PowerShell wrapper forwards the explicit access option', { skip: process.platform !== 'win32' }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'codex-telemetry-powershell-'));
  const dataRoot = join(root, 'data');
  const codexHome = join(root, '.codex');
  await mkdir(join(codexHome, 'sessions'), { recursive: true });
  const env = { ...process.env, CODEX_BUNDLED_NODE: process.execPath, CODEX_TELEMETRY_DATA_DIR: dataRoot, CODEX_HOME: codexHome };
  let runtime = null;
  t.after(async () => {
    if (runtime) { try { process.kill(runtime.pid, 'SIGTERM'); } catch { /* already stopped */ } }
    await rm(root, { recursive: true, force: true });
  });
  const launched = await runPowerShell(launcherPowerShellPath, env, ['--access=local']);
  runtime = JSON.parse(await readFile(join(dataRoot, 'runtime.json'), 'utf8'));
  assert.equal(launched.accessMode, 'local');
  assert.equal(runtime.host, '127.0.0.1');
  await runNode(stopPath, env);
  runtime = null;
});

test('launcher replaces a healthy legacy service that does not report a version', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'codex-telemetry-upgrade-'));
  const dataRoot = join(root, 'data');
  const codexHome = join(root, '.codex');
  await mkdir(join(codexHome, 'sessions'), { recursive: true });
  const env = { ...process.env, CODEX_TELEMETRY_DATA_DIR: dataRoot, CODEX_HOME: codexHome };
  const legacy = spawnLegacy(env);
  let runtime = null;
  t.after(async () => {
    if (legacy.exitCode === null) legacy.kill();
    if (runtime) { try { process.kill(runtime.pid, 'SIGTERM'); } catch { /* already stopped */ } }
    await rm(root, { recursive: true, force: true });
  });

  const legacyRuntime = await waitForRuntime(join(dataRoot, 'runtime.json'));
  const launched = await runNode(launcherPath, env);
  await waitForExit(legacy);
  runtime = await waitForRuntime(join(dataRoot, 'runtime.json'));
  assert.equal(launched.reused, false);
  assert.equal(launched.version, '1.4.0');
  assert.notEqual(launched.pid, legacyRuntime.pid);
  assert.equal(runtime.version, '1.4.0');

  await runNode(stopPath, env);
  runtime = null;
});

test('launcher aborts when a mismatched service rejects shutdown', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'codex-telemetry-upgrade-failure-'));
  const dataRoot = join(root, 'data');
  const codexHome = join(root, '.codex');
  await mkdir(join(codexHome, 'sessions'), { recursive: true });
  const env = { ...process.env, CODEX_TELEMETRY_DATA_DIR: dataRoot, CODEX_HOME: codexHome };
  const legacy = spawnLegacy(env, true);
  t.after(async () => {
    if (legacy.exitCode === null) legacy.kill();
    await waitForExit(legacy).catch(() => {});
    await rm(root, { recursive: true, force: true });
  });

  const legacyRuntime = await waitForRuntime(join(dataRoot, 'runtime.json'));
  await assert.rejects(runNode(launcherPath, env), /rejected shutdown with HTTP 500/u);
  assert.equal(legacy.exitCode, null);
  assert.equal((await waitForRuntime(join(dataRoot, 'runtime.json'))).pid, legacyRuntime.pid);
});

test('CLI starts, inspects, and stops the dashboard without opening a browser', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'codex-telemetry-cli-'));
  const dataRoot = join(root, 'data');
  const codexHome = join(root, '.codex');
  await mkdir(join(codexHome, 'sessions'), { recursive: true });
  const env = { ...process.env, CODEX_TELEMETRY_DATA_DIR: dataRoot, CODEX_HOME: codexHome };
  let runtime = null;
  t.after(async () => {
    if (runtime) { try { process.kill(runtime.pid, 'SIGTERM'); } catch { /* already stopped */ } }
    await rm(root, { recursive: true, force: true });
  });

  const started = await runNode(cliPath, env, ['start', '--no-open', '--json']);
  runtime = await waitForRuntime(join(dataRoot, 'runtime.json'));
  assert.equal(started.opened, false);
  assert.equal(started.reused, false);
  assert.equal(started.accessMode, 'local');
  assert.equal(started.version, '1.4.0');

  const status = await runNode(cliPath, env, ['status', '--json']);
  assert.equal(status.running, true);
  assert.equal(status.pid, started.pid);
  assert.equal(status.version, '1.4.0');

  const stopped = await runNode(cliPath, env, ['stop', '--json']);
  assert.equal(stopped.stopped, true);
  assert.equal(stopped.pid, started.pid);
  runtime = null;
});

test('CLI status reports stale runtime without removing it', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'codex-telemetry-cli-stale-'));
  const dataRoot = join(root, 'data');
  const runtimePath = join(dataRoot, 'runtime.json');
  await mkdir(dataRoot, { recursive: true });
  await writeFile(runtimePath, JSON.stringify({ pid: 999999, port: 9, token: 'stale' }));
  t.after(() => rm(root, { recursive: true, force: true }));

  const status = await runNode(cliPath, { ...process.env, CODEX_TELEMETRY_DATA_DIR: dataRoot }, ['status', '--json']);
  assert.deepEqual(status, { running: false, reason: 'stale-runtime' });
  assert.equal(JSON.parse(await readFile(runtimePath, 'utf8')).token, 'stale');
});
