import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, mkdir, open, readFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildAccessUrls, normalizeAccessMode } from './access-mode.mjs';
import { resolveDataRoot, sqliteNodeFlags } from './platform-paths.mjs';

const scriptRoot = dirname(fileURLToPath(import.meta.url));
const pluginRoot = dirname(scriptRoot);
const serverPath = join(scriptRoot, 'server.mjs');
const manifestPath = join(pluginRoot, '.codex-plugin', 'plugin.json');

function runtimePath() {
  return join(resolveDataRoot(), 'runtime.json');
}

export function assertNodeVersion() {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 5)) {
    throw new Error(`Node.js 22.5 or newer is required for node:sqlite. Found v${process.versions.node}.`);
  }
}

export async function readVersion() {
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (typeof manifest.version !== 'string' || !manifest.version.trim()) throw new Error('Plugin manifest version is required.');
  return manifest.version.trim();
}

export async function readRuntime() {
  try { return JSON.parse(await readFile(runtimePath(), 'utf8')); } catch { return null; }
}

async function request(runtime, pathname, method = 'GET', timeoutMs = 2000) {
  if (!runtime?.port || !runtime?.token) return null;
  try {
    return await fetch(`http://127.0.0.1:${runtime.port}${pathname}`, {
      method,
      headers: { 'X-Dashboard-Token': String(runtime.token) },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch { return null; }
}

async function health(runtime) {
  const response = await request(runtime, '/api/health', 'GET', 1000);
  if (!response?.ok) return null;
  try {
    const payload = await response.json();
    return payload?.ok === true ? payload : null;
  } catch { return null; }
}

function processExists(pid) {
  try { process.kill(Number(pid), 0); return true; } catch { return false; }
}

async function waitForExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processExists(pid)) return true;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  return !processExists(pid);
}

function accessDetails(runtime) {
  const accessMode = normalizeAccessMode(runtime.accessMode, runtime.host === '0.0.0.0' ? 'lan' : 'local');
  const urls = buildAccessUrls({ mode: accessMode, port: runtime.port, token: runtime.token, hosts: runtime.hosts });
  return { url: urls[0], urls, accessMode };
}

function launchResult(runtime, reused, version) {
  return {
    ...accessDetails(runtime),
    pid: Number(runtime.pid),
    reused,
    version,
  };
}

export async function getDashboardStatus() {
  const runtime = await readRuntime();
  if (!runtime) return { running: false, reason: 'not-running' };
  const currentHealth = await health(runtime);
  if (!currentHealth) return { running: false, reason: 'stale-runtime' };
  try {
    return {
      running: true,
      ...accessDetails(runtime),
      pid: Number(runtime.pid),
      version: currentHealth.version ?? runtime.version ?? null,
      startedAtMs: Number(runtime.startedAtMs) || null,
    };
  } catch {
    return { running: false, reason: 'stale-runtime' };
  }
}

async function shutdownExisting(runtime, reason) {
  let response;
  try {
    response = await fetch(`http://127.0.0.1:${runtime.port}/api/shutdown`, {
      method: 'POST',
      headers: { 'X-Dashboard-Token': String(runtime.token) },
      signal: AbortSignal.timeout(2000),
    });
  } catch (error) {
    throw new Error(`Running dashboard ${reason} and could not be stopped: ${error.message}`);
  }
  if (!response.ok) throw new Error(`Running dashboard ${reason} and rejected shutdown with HTTP ${response.status}.`);
  if (!await waitForExit(runtime.pid, 3000)) throw new Error(`Running dashboard ${reason} but did not exit after shutdown.`);
}

export async function startDashboard(options = {}) {
  assertNodeVersion();
  const version = await readVersion();
  const accessMode = normalizeAccessMode(options.accessMode, 'local');
  const existing = await readRuntime();
  const existingHealth = await health(existing);
  if (existingHealth) {
    const existingMode = normalizeAccessMode(existing.accessMode, existing.host === '0.0.0.0' ? 'lan' : 'local');
    if (existingHealth.version === version && existingMode === accessMode) return launchResult(existing, true, version);
    const reason = existingHealth.version !== version ? 'version differs' : 'access mode differs';
    await shutdownExisting(existing, reason);
  }

  const dataRoot = resolveDataRoot();
  await mkdir(dataRoot, { recursive: true });
  await access(serverPath, constants.R_OK);
  const stdout = await open(join(dataRoot, 'server.stdout.log'), 'a', 0o600);
  const stderr = await open(join(dataRoot, 'server.stderr.log'), 'a', 0o600);
  const child = spawn(process.execPath, [...sqliteNodeFlags(), serverPath], {
    cwd: pluginRoot,
    detached: true,
    windowsHide: true,
    stdio: ['ignore', stdout.fd, stderr.fd],
    env: { ...process.env, CODEX_TELEMETRY_ACCESS_MODE: accessMode },
  });
  child.unref();
  await stdout.close();
  await stderr.close();

  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 150));
    const runtime = await readRuntime();
    const childHealth = runtime?.pid === child.pid ? await health(runtime) : null;
    if (childHealth?.version === version) return launchResult(runtime, false, version);
  }
  try { process.kill(child.pid, 'SIGTERM'); } catch { /* already stopped */ }
  let details = 'No error log was produced.';
  try { details = (await readFile(join(dataRoot, 'server.stderr.log'), 'utf8')).slice(-4000); } catch { /* no log */ }
  throw new Error(`The telemetry dashboard did not start within 10 seconds. ${details}`);
}

export async function stopDashboard() {
  const runtime = await readRuntime();
  if (!runtime) return { stopped: false, reason: 'not-running' };

  const currentHealth = await request(runtime, '/api/health');
  if (!currentHealth?.ok) {
    await rm(runtimePath(), { force: true });
    return { stopped: false, reason: 'stale-runtime-removed' };
  }

  const shutdown = await request(runtime, '/api/shutdown', 'POST');
  if (!shutdown?.ok) throw new Error('The dashboard accepted authentication but rejected shutdown.');
  let forced = false;
  if (!await waitForExit(Number(runtime.pid), 2500)) {
    forced = true;
    process.kill(Number(runtime.pid), 'SIGTERM');
    if (!await waitForExit(Number(runtime.pid), 1500)) process.kill(Number(runtime.pid), 'SIGKILL');
  }
  await rm(runtimePath(), { force: true });
  return { stopped: true, pid: Number(runtime.pid), forced };
}
