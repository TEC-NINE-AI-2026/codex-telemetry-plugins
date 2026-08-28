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
const manifestPath = join(pluginRoot, '.codex-plugin', 'plugin.json');

function assertNodeVersion() {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 5)) {
    throw new Error(`Node.js 22.5 or newer is required for node:sqlite. Found v${process.versions.node}.`);
  }
}

async function readRuntime() {
  try { return JSON.parse(await readFile(runtimePath, 'utf8')); } catch { return null; }
}

async function readVersion() {
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (typeof manifest.version !== 'string' || !manifest.version.trim()) throw new Error('Plugin manifest version is required.');
  return manifest.version.trim();
}

async function health(runtime) {
  if (!runtime?.port || !runtime?.token || !runtime?.pid) return null;
  try {
    const response = await fetch(`http://127.0.0.1:${runtime.port}/api/health`, {
      headers: { 'X-Dashboard-Token': String(runtime.token) },
      signal: AbortSignal.timeout(1000),
    });
    if (!response.ok) return null;
    const payload = await response.json();
    return payload?.ok === true ? payload : null;
  } catch { return null; }
}

function processExists(pid) {
  try { process.kill(Number(pid), 0); return true; } catch { return false; }
}

async function waitForExit(pid, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processExists(pid)) return true;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  return !processExists(pid);
}

async function shutdownMismatched(runtime) {
  let response;
  try {
    response = await fetch(`http://127.0.0.1:${runtime.port}/api/shutdown`, {
      method: 'POST',
      headers: { 'X-Dashboard-Token': String(runtime.token) },
      signal: AbortSignal.timeout(2000),
    });
  } catch (error) {
    throw new Error(`Running dashboard version differs and could not be stopped: ${error.message}`);
  }
  if (!response.ok) throw new Error(`Running dashboard version differs and rejected shutdown with HTTP ${response.status}.`);
  if (!await waitForExit(runtime.pid)) throw new Error('Running dashboard version differs but did not exit after shutdown.');
}

function result(runtime, reused, version) {
  return { url: `http://127.0.0.1:${runtime.port}/#token=${runtime.token}`, pid: Number(runtime.pid), reused, version };
}

async function main() {
  assertNodeVersion();
  const version = await readVersion();
  const existing = await readRuntime();
  const existingHealth = await health(existing);
  if (existingHealth) {
    if (existingHealth.version === version) {
      process.stdout.write(`${JSON.stringify(result(existing, true, version))}\n`);
      return;
    }
    await shutdownMismatched(existing);
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
    const childHealth = runtime?.pid === child.pid ? await health(runtime) : null;
    if (childHealth?.version === version) {
      process.stdout.write(`${JSON.stringify(result(runtime, false, version))}\n`);
      return;
    }
  }
  try { process.kill(child.pid, 'SIGTERM'); } catch { /* already stopped */ }
  let details = 'No error log was produced.';
  try { details = (await readFile(join(dataRoot, 'server.stderr.log'), 'utf8')).slice(-4000); } catch { /* no log */ }
  throw new Error(`The telemetry dashboard did not start within 10 seconds. ${details}`);
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
