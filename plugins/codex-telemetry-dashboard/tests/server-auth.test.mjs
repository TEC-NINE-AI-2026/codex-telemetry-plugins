import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const testRoot = dirname(fileURLToPath(import.meta.url));
const serverPath = join(testRoot, '..', 'scripts', 'server.mjs');

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
    new Promise((_, reject) => setTimeout(() => reject(new Error('server did not exit')), timeoutMs)),
  ]);
}

async function removeWithRetry(path) {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    try { await rm(path, { recursive: true, force: true }); return; }
    catch (error) {
      if (error.code !== 'EBUSY' || attempt === 11) throw error;
      await new Promise((resolve) => setTimeout(resolve, 80));
    }
  }
}

test('server binds localhost and rejects API requests without the local token', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'codex-telemetry-server-'));
  const dataRoot = join(root, 'data');
  const codexHome = join(root, '.codex');
  await mkdir(join(codexHome, 'sessions'), { recursive: true });
  const child = spawn(process.execPath, [serverPath], {
    env: { ...process.env, CODEX_TELEMETRY_DATA_DIR: dataRoot, CODEX_HOME: codexHome },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  t.after(async () => {
    if (child.exitCode === null) child.kill();
    await waitForExit(child).catch(() => {});
    await removeWithRetry(root);
  });
  const runtimePath = join(dataRoot, 'runtime.json');
  const runtime = await waitForRuntime(runtimePath);
  assert.equal(runtime.host, '127.0.0.1');
  assert.equal(runtime.version, '1.4.0');
  const base = `http://127.0.0.1:${runtime.port}`;
  assert.equal((await fetch(`${base}/api/health`)).status, 401);
  const authorized = await fetch(`${base}/api/health`, { headers: { 'X-Dashboard-Token': runtime.token } });
  assert.equal(authorized.status, 200);
  const health = await authorized.json();
  assert.equal(health.ok, true);
  assert.equal(health.version, '1.4.0');
  const summary = await fetch(`${base}/api/summary?range=all`, { headers: { 'X-Dashboard-Token': runtime.token } });
  assert.equal(summary.status, 200);
  const summaryPayload = await summary.json();
  assert.equal(summaryPayload.version, '1.4.0');
  assert.deepEqual(summaryPayload.access, { mode: 'local', bindHost: '127.0.0.1', hosts: ['127.0.0.1'] });
  const analytics = await fetch(`${base}/api/analytics?range=all`, { headers: { 'X-Dashboard-Token': runtime.token } });
  assert.equal(analytics.status, 200);
  const payload = await analytics.json();
  for (const key of ['coverage', 'overview', 'efficiency', 'cache', 'tools', 'agents', 'context', 'reliability', 'concurrency', 'workModes']) assert.ok(key in payload);
  await fetch(`${base}/api/shutdown`, { method: 'POST', headers: { 'X-Dashboard-Token': runtime.token } });
  await waitForExit(child);
});

test('LAN mode binds all IPv4 interfaces while retaining token authentication', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'codex-telemetry-server-lan-'));
  const dataRoot = join(root, 'data');
  const codexHome = join(root, '.codex');
  await mkdir(join(codexHome, 'sessions'), { recursive: true });
  const child = spawn(process.execPath, [serverPath], {
    env: { ...process.env, CODEX_TELEMETRY_DATA_DIR: dataRoot, CODEX_HOME: codexHome, CODEX_TELEMETRY_ACCESS_MODE: 'lan' },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  t.after(async () => {
    if (child.exitCode === null) child.kill();
    await waitForExit(child).catch(() => {});
    await removeWithRetry(root);
  });
  const runtime = await waitForRuntime(join(dataRoot, 'runtime.json'));
  assert.equal(runtime.host, '0.0.0.0');
  assert.equal(runtime.accessMode, 'lan');
  assert.equal(runtime.hosts[0], '127.0.0.1');
  const base = `http://127.0.0.1:${runtime.port}`;
  assert.equal((await fetch(`${base}/api/summary?range=all`)).status, 401);
  const response = await fetch(`${base}/api/summary?range=all`, { headers: { 'X-Dashboard-Token': runtime.token } });
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.access.mode, 'lan');
  assert.equal(payload.access.bindHost, '0.0.0.0');
  assert.equal(payload.access.hosts[0], '127.0.0.1');
  await fetch(`${base}/api/shutdown`, { method: 'POST', headers: { 'X-Dashboard-Token': runtime.token } });
  await waitForExit(child);
});
