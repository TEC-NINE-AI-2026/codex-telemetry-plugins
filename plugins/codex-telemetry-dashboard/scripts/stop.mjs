import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { resolveDataRoot } from './platform-paths.mjs';

const runtimePath = join(resolveDataRoot(), 'runtime.json');

async function readRuntime() {
  try { return JSON.parse(await readFile(runtimePath, 'utf8')); } catch { return null; }
}

async function request(runtime, pathname, method = 'GET') {
  try {
    return await fetch(`http://127.0.0.1:${runtime.port}${pathname}`, {
      method,
      headers: { 'X-Dashboard-Token': String(runtime.token) },
      signal: AbortSignal.timeout(2000),
    });
  } catch { return null; }
}

function processExists(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function waitForExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processExists(pid)) return true;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  return !processExists(pid);
}

async function main() {
  const runtime = await readRuntime();
  if (!runtime) {
    process.stdout.write(`${JSON.stringify({ stopped: false, reason: 'not-running' })}\n`);
    return;
  }

  const health = await request(runtime, '/api/health');
  if (!health?.ok) {
    await rm(runtimePath, { force: true });
    process.stdout.write(`${JSON.stringify({ stopped: false, reason: 'stale-runtime-removed' })}\n`);
    return;
  }

  const shutdown = await request(runtime, '/api/shutdown', 'POST');
  if (!shutdown?.ok) throw new Error('The dashboard accepted authentication but rejected shutdown.');
  let forced = false;
  if (!await waitForExit(Number(runtime.pid), 2500)) {
    forced = true;
    process.kill(Number(runtime.pid), 'SIGTERM');
    if (!await waitForExit(Number(runtime.pid), 1500)) process.kill(Number(runtime.pid), 'SIGKILL');
  }
  await rm(runtimePath, { force: true });
  process.stdout.write(`${JSON.stringify({ stopped: true, pid: Number(runtime.pid), forced })}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
