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
  const base = `http://127.0.0.1:${runtime.port}`;
  assert.equal((await fetch(`${base}/api/health`)).status, 401);
  const authorized = await fetch(`${base}/api/health`, { headers: { 'X-Dashboard-Token': runtime.token } });
  assert.equal(authorized.status, 200);
  assert.equal((await authorized.json()).ok, true);
  const analytics = await fetch(`${base}/api/analytics?range=all`, { headers: { 'X-Dashboard-Token': runtime.token } });
  assert.equal(analytics.status, 200);
  const payload = await analytics.json();
  for (const key of ['coverage', 'overview', 'efficiency', 'cache', 'tools', 'agents', 'context', 'reliability', 'concurrency', 'workModes']) assert.ok(key in payload);
  await fetch(`${base}/api/shutdown`, { method: 'POST', headers: { 'X-Dashboard-Token': runtime.token } });
  await waitForExit(child);
});
