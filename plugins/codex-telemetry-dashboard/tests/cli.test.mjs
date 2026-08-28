import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { browserCommand, openBrowser } from '../scripts/browser-open.mjs';
import { CliUsageError, parseCliArgs, runCli } from '../scripts/cli.mjs';

const testRoot = dirname(fileURLToPath(import.meta.url));

function captureIo() {
  let stdout = '';
  let stderr = '';
  return {
    io: {
      stdout: { write: (value) => { stdout += value; } },
      stderr: { write: (value) => { stderr += value; } },
    },
    stdout: () => stdout,
    stderr: () => stderr,
  };
}

function launchResult(overrides = {}) {
  return {
    url: 'http://127.0.0.1:4321/#token=test-token',
    urls: ['http://127.0.0.1:4321/#token=test-token'],
    accessMode: 'local',
    pid: 1234,
    reused: false,
    version: '1.4.0',
    ...overrides,
  };
}

test('CLI parser defaults to start and validates command-specific options', () => {
  assert.deepEqual(parseCliArgs([]), {
    command: 'start', accessMode: null, noOpen: false, json: false, help: false, version: false,
  });
  assert.deepEqual(parseCliArgs(['start', '--access', 'lan', '--no-open', '--json']), {
    command: 'start', accessMode: 'lan', noOpen: true, json: true, help: false, version: false,
  });
  assert.throws(() => parseCliArgs(['status', '--access=lan']), CliUsageError);
  assert.throws(() => parseCliArgs(['open', '--no-open']), CliUsageError);
  assert.throws(() => parseCliArgs(['unknown']), CliUsageError);
});

test('CLI executable returns exit code 2 for invalid usage', () => {
  const cliPath = join(testRoot, '..', 'scripts', 'cli.mjs');
  const result = spawnSync(process.execPath, [cliPath, 'unknown'], { encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Unknown command: unknown/u);
  assert.match(result.stderr, /--help/u);
});

test('start defaults to opening the browser and supports JSON without opening', async () => {
  let openedUrl = null;
  let requestedMode = null;
  const capture = captureIo();
  const dependencies = {
    startDashboard: async ({ accessMode }) => { requestedMode = accessMode; return launchResult(); },
    openBrowser: async (url) => { openedUrl = url; },
  };

  assert.equal(await runCli([], { io: capture.io, dependencies }), 0);
  assert.equal(requestedMode, 'local');
  assert.equal(openedUrl, launchResult().url);
  assert.match(capture.stdout(), /Dashboard started/u);

  const jsonCapture = captureIo();
  openedUrl = null;
  assert.equal(await runCli(['start', '--access=lan', '--no-open', '--json'], { io: jsonCapture.io, dependencies }), 0);
  assert.equal(requestedMode, 'lan');
  assert.equal(openedUrl, null);
  assert.deepEqual(JSON.parse(jsonCapture.stdout()), { ...launchResult(), opened: false });
  assert.match(jsonCapture.stderr(), /unencrypted HTTP/u);
});

test('open reuses a healthy service and starts local when no service is running', async () => {
  let startCount = 0;
  let openCount = 0;
  const running = { running: true, ...launchResult({ reused: undefined }), startedAtMs: 10 };
  delete running.reused;
  const dependencies = {
    getDashboardStatus: async () => running,
    startDashboard: async () => { startCount += 1; return launchResult(); },
    openBrowser: async () => { openCount += 1; },
  };
  const capture = captureIo();
  assert.equal(await runCli(['open', '--json'], { io: capture.io, dependencies }), 0);
  assert.equal(startCount, 0);
  assert.equal(openCount, 1);
  assert.equal(JSON.parse(capture.stdout()).reused, true);

  dependencies.getDashboardStatus = async () => ({ running: false, reason: 'not-running' });
  const stoppedCapture = captureIo();
  assert.equal(await runCli(['open', '--json'], { io: stoppedCapture.io, dependencies }), 0);
  assert.equal(startCount, 1);
  assert.equal(openCount, 2);
  assert.equal(JSON.parse(stoppedCapture.stdout()).accessMode, 'local');
});

test('browser failure preserves the launch result and returns a nonzero code', async () => {
  const capture = captureIo();
  const code = await runCli(['start', '--json'], {
    io: capture.io,
    dependencies: {
      startDashboard: async () => launchResult(),
      openBrowser: async () => { throw new Error('no opener'); },
    },
  });
  assert.equal(code, 1);
  assert.equal(JSON.parse(capture.stdout()).opened, false);
  assert.match(capture.stderr(), /no opener/u);
});

test('status and repeated stop are successful observable results', async () => {
  const statusCapture = captureIo();
  assert.equal(await runCli(['status', '--json'], {
    io: statusCapture.io,
    dependencies: { getDashboardStatus: async () => ({ running: false, reason: 'not-running' }) },
  }), 0);
  assert.deepEqual(JSON.parse(statusCapture.stdout()), { running: false, reason: 'not-running' });

  const stopCapture = captureIo();
  assert.equal(await runCli(['stop', '--json'], {
    io: stopCapture.io,
    dependencies: { stopDashboard: async () => ({ stopped: false, reason: 'not-running' }) },
  }), 0);
  assert.deepEqual(JSON.parse(stopCapture.stdout()), { stopped: false, reason: 'not-running' });
});

test('help, version, and package bin metadata are available', async () => {
  const helpCapture = captureIo();
  assert.equal(await runCli(['--help'], { io: helpCapture.io }), 0);
  assert.match(helpCapture.stdout(), /codex-telemetry status/u);

  const versionCapture = captureIo();
  assert.equal(await runCli(['--version'], {
    io: versionCapture.io,
    dependencies: { readVersion: async () => '1.4.0' },
  }), 0);
  assert.equal(versionCapture.stdout(), '1.4.0\n');

  const packageJson = JSON.parse(await readFile(join(testRoot, '..', '..', '..', 'package.json'), 'utf8'));
  assert.equal(packageJson.bin['codex-telemetry'], './plugins/codex-telemetry-dashboard/scripts/cli.mjs');
  const cli = await readFile(join(testRoot, '..', 'scripts', 'cli.mjs'), 'utf8');
  assert.ok(cli.startsWith('#!/usr/bin/env node\n'));
});

test('browser commands are platform-specific and detached opening is observable', async () => {
  const url = 'http://127.0.0.1:4321/#token=test';
  assert.deepEqual(browserCommand(url, 'win32'), { command: 'explorer.exe', args: [url] });
  assert.deepEqual(browserCommand(url, 'darwin'), { command: 'open', args: [url] });
  assert.deepEqual(browserCommand(url, 'linux'), { command: 'xdg-open', args: [url] });

  let invocation = null;
  let unrefCalled = false;
  await openBrowser(url, {
    platform: 'linux',
    spawnImpl(command, args, options) {
      invocation = { command, args, options };
      const child = new EventEmitter();
      child.unref = () => { unrefCalled = true; };
      setImmediate(() => child.emit('spawn'));
      return child;
    },
  });
  assert.equal(invocation.command, 'xdg-open');
  assert.deepEqual(invocation.args, [url]);
  assert.equal(invocation.options.detached, true);
  assert.equal(unrefCalled, true);
});
