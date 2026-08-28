import { createServer } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const dataRoot = process.env.CODEX_TELEMETRY_DATA_DIR;
const runtimePath = join(dataRoot, 'runtime.json');
const token = 'legacy-dashboard-test-token';
const rejectShutdown = process.env.LEGACY_REJECT_SHUTDOWN === '1';

await mkdir(dataRoot, { recursive: true });

const server = createServer((request, response) => {
  if (request.headers['x-dashboard-token'] !== token) {
    response.writeHead(401).end();
    return;
  }
  if (request.method === 'GET' && request.url === '/api/health') {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ ok: true, pid: process.pid }));
    return;
  }
  if (request.method === 'POST' && request.url === '/api/shutdown') {
    if (rejectShutdown) {
      response.writeHead(500).end();
      return;
    }
    response.writeHead(200).end();
    setTimeout(() => server.close(() => process.exit(0)), 20).unref();
    return;
  }
  response.writeHead(404).end();
});

server.listen(0, '127.0.0.1', async () => {
  const address = server.address();
  await writeFile(runtimePath, JSON.stringify({ pid: process.pid, host: '127.0.0.1', port: address.port, token }));
  process.stdout.write(`${JSON.stringify({ ok: true, pid: process.pid, port: address.port })}\n`);
});

function shutdown() {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1000).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
