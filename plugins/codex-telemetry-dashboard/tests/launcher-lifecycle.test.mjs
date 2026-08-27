import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const testRoot = dirname(fileURLToPath(import.meta.url));
const launcherPath = join(testRoot, '..', 'scripts', 'launcher.mjs');
const stopPath = join(testRoot, '..', 'scripts', 'stop.mjs');

function runNode(script, env) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [script], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('exit', (code) => code === 0 ? resolvePromise(JSON.parse(stdout)) : reject(new Error(stderr || `exit ${code}`)));
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
  assert.equal(second.reused, true);
  assert.equal(second.pid, first.pid);
  assert.equal(new URL(first.url).hostname, '127.0.0.1');

  const stopped = await runNode(stopPath, env);
  assert.equal(stopped.stopped, true);
  assert.equal(stopped.pid, first.pid);
  runtime = null;
});
