import test from 'node:test';
import assert from 'node:assert/strict';
import { posix, win32 } from 'node:path';
import { bundledNodeCandidates, resolveDataRoot, sqliteNodeFlags } from '../scripts/platform-paths.mjs';

test('data root follows native Windows, macOS, and Linux conventions', () => {
  assert.equal(resolveDataRoot({ platform: 'win32', env: { LOCALAPPDATA: 'C:\\Local' }, home: 'C:\\Users\\tester' }), win32.join('C:\\Local', 'CodexTelemetryDashboard'));
  assert.equal(resolveDataRoot({ platform: 'darwin', env: {}, home: '/Users/tester' }), '/Users/tester/Library/Application Support/CodexTelemetryDashboard');
  assert.equal(resolveDataRoot({ platform: 'linux', env: { XDG_DATA_HOME: '/tmp/data' }, home: '/home/tester' }), '/tmp/data/CodexTelemetryDashboard');
  assert.equal(resolveDataRoot({ platform: 'darwin', env: { CODEX_TELEMETRY_DATA_DIR: '/tmp/custom' }, home: '/Users/tester' }), posix.resolve('/tmp/custom'));
});

test('bundled Node discovery includes both common macOS runtime cache locations', () => {
  const candidates = bundledNodeCandidates({ platform: 'darwin', env: {}, home: '/Users/tester' });
  assert.deepEqual(candidates, [
    '/Users/tester/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node',
    '/Users/tester/Library/Caches/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node',
  ]);
});

test('early Node 22 and 23 releases receive the SQLite feature flag', () => {
  assert.deepEqual(sqliteNodeFlags('22.5.0'), ['--experimental-sqlite']);
  assert.deepEqual(sqliteNodeFlags('22.12.0'), ['--experimental-sqlite']);
  assert.deepEqual(sqliteNodeFlags('22.13.0'), []);
  assert.deepEqual(sqliteNodeFlags('23.3.0'), ['--experimental-sqlite']);
  assert.deepEqual(sqliteNodeFlags('23.4.0'), []);
  assert.deepEqual(sqliteNodeFlags('24.0.0'), []);
});
