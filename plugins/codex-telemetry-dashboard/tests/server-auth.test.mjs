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
    if (!child.killed) child.kill();
    await rm(root, { recursive: true, force: true });
  });
  const runtimePath = join(dataRoot, 'runtime.json');
  const runtime = await waitForRuntime(runtimePath);
  assert.equal(runtime.host, '127.0.0.1');
  const base = `http://127.0.0.1:${runtime.port}`;
  assert.equal((await fetch(`${base}/api/health`)).status, 401);
  const authorized = await fetch(`${base}/api/health`, { headers: { 'X-Dashboard-Token': runtime.token } });
  assert.equal(authorized.status, 200);
  assert.equal((await authorized.json()).ok, true);
  await fetch(`${base}/api/shutdown`, { method: 'POST', headers: { 'X-Dashboard-Token': runtime.token } });
});
