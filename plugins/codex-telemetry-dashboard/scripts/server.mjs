import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TelemetryCollector, TelemetryStore } from './telemetry-core.mjs';
import { resolveDataRoot } from './platform-paths.mjs';

const scriptRoot = dirname(fileURLToPath(import.meta.url));
const pluginRoot = dirname(scriptRoot);
const assetRoot = join(pluginRoot, 'assets');
const dataRoot = resolveDataRoot();
const databasePath = process.env.CODEX_TELEMETRY_DB || join(dataRoot, 'metrics.sqlite');
const runtimePath = join(dataRoot, 'runtime.json');
const token = randomBytes(24).toString('base64url');
const host = '127.0.0.1';

await mkdir(dataRoot, { recursive: true });

const assets = new Map();
for (const [route, file, type] of [
  ['/', 'index.html', 'text/html; charset=utf-8'],
  ['/index.html', 'index.html', 'text/html; charset=utf-8'],
  ['/dashboard.js', 'dashboard.js', 'text/javascript; charset=utf-8'],
  ['/dashboard-state.mjs', 'dashboard-state.mjs', 'text/javascript; charset=utf-8'],
  ['/styles.css', 'styles.css', 'text/css; charset=utf-8'],
  ['/logo.svg', 'logo.svg', 'image/svg+xml'],
]) {
  assets.set(route, { body: await readFile(join(assetRoot, file)), type });
}

const store = new TelemetryStore(databasePath);
const collector = new TelemetryCollector(store, { pollIntervalMs: 1000 });
const sseClients = new Set();

function securityHeaders(contentType) {
  return {
    'Content-Type': contentType,
    'Cache-Control': contentType.startsWith('text/html') ? 'no-store' : 'public, max-age=300',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'SAMEORIGIN',
    'Referrer-Policy': 'no-referrer',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'self'",
  };
}

function sendJson(response, status, value) {
  const body = Buffer.from(JSON.stringify(value));
  response.writeHead(status, { ...securityHeaders('application/json; charset=utf-8'), 'Content-Length': body.length });
  response.end(body);
}

function authorized(request) {
  const supplied = request.headers['x-dashboard-token'];
  return typeof supplied === 'string' && supplied.length === token.length && supplied === token;
}

async function readJsonBody(request, limit = 16_384) {
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > limit) throw new Error('Request body too large');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function filtersFrom(url) {
  return {
    range: url.searchParams.get('range') || '7d',
    project: url.searchParams.get('project') || '',
    model: url.searchParams.get('model') || '',
    effort: url.searchParams.get('effort') || '',
    status: url.searchParams.get('status') || '',
    mode: url.searchParams.get('mode') || '',
  };
}

function publish(type = 'refresh', data = {}) {
  const message = `event: ${type}\ndata: ${JSON.stringify({ at: Date.now(), ...data })}\n\n`;
  for (const response of sseClients) {
    try { response.write(message); } catch { sseClients.delete(response); }
  }
}

collector.on('change', () => publish('refresh'));
collector.on('error', (error) => {
  store.recordDiagnostic(`collector_error:${error.code || error.name || 'unknown'}`);
  publish('diagnostic', { message: '采集器遇到错误，已记录诊断信息。' });
});
collector.start();

let shuttingDown = false;
const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url || '/', `http://${host}`);
    if (url.pathname.startsWith('/api/')) {
      if (!authorized(request)) return sendJson(response, 401, { error: 'unauthorized' });
      if (request.method === 'GET' && url.pathname === '/api/health') {
        return sendJson(response, 200, { ok: true, pid: process.pid, importing: collector.importing });
      }
      if (request.method === 'GET' && url.pathname === '/api/summary') {
        return sendJson(response, 200, store.summary(filtersFrom(url), { importing: collector.importing }));
      }
      if (request.method === 'GET' && url.pathname === '/api/analytics') {
        return sendJson(response, 200, store.analytics(filtersFrom(url)));
      }
      if (request.method === 'GET' && url.pathname === '/api/tasks') {
        return sendJson(response, 200, { generatedAtMs: Date.now(), tasks: store.taskList(filtersFrom(url)) });
      }
      const match = url.pathname.match(/^\/api\/tasks\/([^/]+)\/turns$/u);
      if (request.method === 'GET' && match) {
        return sendJson(response, 200, { generatedAtMs: Date.now(), turns: store.taskTurns(decodeURIComponent(match[1]), filtersFrom(url)) });
      }
      if (request.method === 'GET' && url.pathname === '/api/events') {
        response.writeHead(200, {
          ...securityHeaders('text/event-stream; charset=utf-8'),
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
        });
        response.write(`event: ready\ndata: ${JSON.stringify({ at: Date.now() })}\n\n`);
        sseClients.add(response);
        const heartbeat = setInterval(() => response.write(': heartbeat\n\n'), 15_000);
        request.on('close', () => { clearInterval(heartbeat); sseClients.delete(response); });
        return;
      }
      if (request.method === 'POST' && url.pathname === '/api/history/clear') {
        const body = await readJsonBody(request);
        if (body.confirm !== 'CLEAR_METRICS') return sendJson(response, 400, { error: 'confirmation_required' });
        const removed = store.clearHistory();
        publish('refresh', { reason: 'history-cleared' });
        return sendJson(response, 200, { ok: true, removed, cutoffMs: Number(store.getSetting('import_cutoff_ms')) });
      }
      if (request.method === 'POST' && url.pathname === '/api/history/reimport') {
        const body = await readJsonBody(request);
        if (body.confirm !== 'REIMPORT_ALL') return sendJson(response, 400, { error: 'confirmation_required' });
        collector.reimport().catch((error) => collector.emit('error', error));
        publish('refresh', { reason: 'reimport-started' });
        return sendJson(response, 202, { ok: true, importing: true });
      }
      if (request.method === 'POST' && url.pathname === '/api/shutdown') {
        sendJson(response, 200, { ok: true });
        setTimeout(shutdown, 50).unref();
        return;
      }
      return sendJson(response, 404, { error: 'not_found' });
    }

    const asset = assets.get(url.pathname);
    if (!asset) {
      const body = Buffer.from('Not found');
      response.writeHead(404, { ...securityHeaders('text/plain; charset=utf-8'), 'Content-Length': body.length });
      response.end(body);
      return;
    }
    response.writeHead(200, { ...securityHeaders(asset.type), 'Content-Length': asset.body.length });
    response.end(asset.body);
  } catch (error) {
    sendJson(response, 500, { error: 'internal_error', message: error.message });
  }
});

server.listen(0, host, async () => {
  const address = server.address();
  const runtime = { pid: process.pid, host, port: address.port, token, startedAtMs: Date.now(), databasePath };
  const temporary = join(dataRoot, `.runtime-${process.pid}-${randomBytes(6).toString('hex')}.json`);
  await writeFile(temporary, JSON.stringify(runtime), { encoding: 'utf8', mode: 0o600 });
  await rename(temporary, runtimePath);
  process.stdout.write(`${JSON.stringify({ ok: true, pid: process.pid, port: address.port })}\n`);
});

async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  collector.stop();
  for (const response of sseClients) response.end();
  sseClients.clear();
  server.close(async () => {
    try {
      const runtime = JSON.parse(await readFile(runtimePath, 'utf8'));
      if (runtime.pid === process.pid) await rm(runtimePath, { force: true });
    } catch { /* The runtime file may already be gone. */ }
    store.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 2000).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('uncaughtException', (error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  shutdown();
});
