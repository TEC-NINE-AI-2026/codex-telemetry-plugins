import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, mkdir, open, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveDataRoot, sqliteNodeFlags } from './platform-paths.mjs';

const scriptRoot = dirname(fileURLToPath(import.meta.url));
const pluginRoot = dirname(scriptRoot);
const dataRoot = resolveDataRoot();
const runtimePath = join(dataRoot, 'runtime.json');
const serverPath = join(scriptRoot, 'server.mjs');

function assertNodeVersion() {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 5)) {
    throw new Error(`Node.js 22.5 or newer is required for node:sqlite. Found v${process.versions.node}.`);
  }
}

async function readRuntime() {
  try { return JSON.parse(await readFile(runtimePath, 'utf8')); } catch { return null; }
}

async function healthy(runtime) {
  if (!runtime?.port || !runtime?.token || !runtime?.pid) return false;
  try {
    const response = await fetch(`http://127.0.0.1:${runtime.port}/api/health`, {
      headers: { 'X-Dashboard-Token': String(runtime.token) },
      signal: AbortSignal.timeout(1000),
    });
    return response.ok && (await response.json()).ok === true;
  } catch { return false; }
}

function result(runtime, reused) {
  return { url: `http://127.0.0.1:${runtime.port}/#token=${runtime.token}`, pid: Number(runtime.pid), reused };
}

async function main() {
  assertNodeVersion();
  const existing = await readRuntime();
  if (await healthy(existing)) {
    process.stdout.write(`${JSON.stringify(result(existing, true))}\n`);
    return;
  }

  await mkdir(dataRoot, { recursive: true });
  await access(serverPath, constants.R_OK);
  const stdout = await open(join(dataRoot, 'server.stdout.log'), 'a', 0o600);
  const stderr = await open(join(dataRoot, 'server.stderr.log'), 'a', 0o600);
  const child = spawn(process.execPath, [...sqliteNodeFlags(), serverPath], {
    cwd: pluginRoot,
    detached: true,
    windowsHide: true,
    stdio: ['ignore', stdout.fd, stderr.fd],
    env: process.env,
  });
  child.unref();
  await stdout.close();
  await stderr.close();

  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 150));
    const runtime = await readRuntime();
    if (runtime?.pid === child.pid && await healthy(runtime)) {
      process.stdout.write(`${JSON.stringify(result(runtime, false))}\n`);
      return;
    }
  }
  let details = 'No error log was produced.';
  try { details = (await readFile(join(dataRoot, 'server.stderr.log'), 'utf8')).slice(-4000); } catch { /* no log */ }
  throw new Error(`The telemetry dashboard did not start within 10 seconds. ${details}`);
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
