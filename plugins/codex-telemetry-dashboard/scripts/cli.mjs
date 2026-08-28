#!/usr/bin/env node

import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { normalizeAccessMode } from './access-mode.mjs';
import { openBrowser } from './browser-open.mjs';
import { getDashboardStatus, readVersion, startDashboard, stopDashboard } from './lifecycle.mjs';

const HELP = `Codex Telemetry Dashboard CLI

Usage:
  codex-telemetry [start] [--access=local|lan] [--no-open] [--json]
  codex-telemetry open [--access=local|lan] [--json]
  codex-telemetry status [--json]
  codex-telemetry stop [--json]
  codex-telemetry --help
  codex-telemetry --version

Commands:
  start    Start or reuse the dashboard and open it in the default browser.
  open     Open the running dashboard, starting it when necessary.
  status   Inspect the dashboard service without changing runtime state.
  stop     Stop the dashboard service.

Options:
  --access=local|lan  Bind to this computer only (default) or the local network.
  --no-open          Start the service without opening a browser.
  --json             Print one machine-readable JSON object.
  --help, -h         Show this help.
  --version, -V      Show the plugin version.
`;

const LAN_WARNING = 'Warning: LAN mode uses unencrypted HTTP. Anyone who can reach this computer and has the dashboard URL or Token can read derived metrics and task excerpts.';

export class CliUsageError extends Error {}

export function parseCliArgs(args = []) {
  const input = [...args];
  let command = 'start';
  if (input[0] && !input[0].startsWith('-')) command = input.shift();
  if (!['start', 'open', 'status', 'stop'].includes(command)) throw new CliUsageError(`Unknown command: ${command}`);

  const result = { command, accessMode: null, noOpen: false, json: false, help: false, version: false };
  for (let index = 0; index < input.length; index += 1) {
    const argument = input[index];
    if (argument === '--help' || argument === '-h') { result.help = true; continue; }
    if (argument === '--version' || argument === '-V') { result.version = true; continue; }
    if (argument === '--json') { result.json = true; continue; }
    if (argument === '--no-open') {
      if (command !== 'start') throw new CliUsageError('--no-open is supported only by start.');
      result.noOpen = true;
      continue;
    }
    if (argument === '--access' || argument.startsWith('--access=')) {
      if (!['start', 'open'].includes(command)) throw new CliUsageError(`--access is not supported by ${command}.`);
      const value = argument === '--access' ? input[++index] : argument.slice('--access='.length);
      if (!value) throw new CliUsageError('--access requires local or lan.');
      try { result.accessMode = normalizeAccessMode(value); } catch (error) { throw new CliUsageError(error.message); }
      continue;
    }
    throw new CliUsageError(`Unknown option: ${argument}`);
  }
  return result;
}

function writeJson(io, value) {
  io.stdout.write(`${JSON.stringify(value)}\n`);
}

function humanStatus(status) {
  if (!status.running) return `Dashboard is not running (${status.reason}).`;
  return `Dashboard is running (${status.accessMode}, PID ${status.pid}, version ${status.version ?? 'unknown'}).\nURL: ${status.url}`;
}

function humanLaunch(result) {
  const lifecycle = result.reused ? 'reused' : 'started';
  const browser = result.opened ? 'Opened' : 'URL';
  return `Dashboard ${lifecycle} (${result.accessMode}, PID ${result.pid}, version ${result.version}).\n${browser}: ${result.url}`;
}

function humanStop(result) {
  if (!result.stopped) return `Dashboard was not running (${result.reason}).`;
  return `Dashboard stopped (PID ${result.pid}${result.forced ? ', forced' : ''}).`;
}

async function launchAndMaybeOpen(options, dependencies, io) {
  const launch = await dependencies.startDashboard({ accessMode: options.accessMode ?? 'local' });
  if (options.noOpen) return { ...launch, opened: false, exitCode: 0 };
  try {
    await dependencies.openBrowser(launch.url);
    return { ...launch, opened: true, exitCode: 0 };
  } catch (error) {
    io.stderr.write(`Failed to open the default browser: ${error.message}\n`);
    return { ...launch, opened: false, exitCode: 1 };
  }
}

export async function runCli(args = process.argv.slice(2), options = {}) {
  const io = options.io ?? { stdout: process.stdout, stderr: process.stderr };
  const dependencies = {
    getDashboardStatus,
    openBrowser,
    readVersion,
    startDashboard,
    stopDashboard,
    ...options.dependencies,
  };
  const parsed = parseCliArgs(args);

  if (parsed.help) {
    io.stdout.write(HELP);
    return 0;
  }
  if (parsed.version) {
    io.stdout.write(`${await dependencies.readVersion()}\n`);
    return 0;
  }
  if (parsed.accessMode === 'lan') io.stderr.write(`${LAN_WARNING}\n`);

  let result;
  if (parsed.command === 'start') {
    result = await launchAndMaybeOpen(parsed, dependencies, io);
    const exitCode = result.exitCode;
    delete result.exitCode;
    if (parsed.json) writeJson(io, result); else io.stdout.write(`${humanLaunch(result)}\n`);
    return exitCode;
  }

  if (parsed.command === 'open') {
    if (parsed.accessMode) {
      result = await launchAndMaybeOpen({ ...parsed, noOpen: false }, dependencies, io);
    } else {
      const status = await dependencies.getDashboardStatus();
      if (status.running) {
        try {
          await dependencies.openBrowser(status.url);
          result = { ...status, reused: true, opened: true, exitCode: 0 };
        } catch (error) {
          io.stderr.write(`Failed to open the default browser: ${error.message}\n`);
          result = { ...status, reused: true, opened: false, exitCode: 1 };
        }
        delete result.running;
        delete result.startedAtMs;
      } else {
        result = await launchAndMaybeOpen({ ...parsed, accessMode: 'local', noOpen: false }, dependencies, io);
      }
    }
    const exitCode = result.exitCode;
    delete result.exitCode;
    if (parsed.json) writeJson(io, result); else io.stdout.write(`${humanLaunch(result)}\n`);
    return exitCode;
  }

  if (parsed.command === 'status') {
    result = await dependencies.getDashboardStatus();
    if (parsed.json) writeJson(io, result); else io.stdout.write(`${humanStatus(result)}\n`);
    return 0;
  }

  result = await dependencies.stopDashboard();
  if (parsed.json) writeJson(io, result); else io.stdout.write(`${humanStop(result)}\n`);
  return 0;
}

async function main() {
  try {
    process.exitCode = await runCli();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    if (error instanceof CliUsageError) process.stderr.write('Run codex-telemetry --help for usage.\n');
    process.exitCode = error instanceof CliUsageError ? 2 : 1;
  }
}

function isDirectExecution() {
  if (!process.argv[1]) return false;
  try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
}

if (isDirectExecution()) main();
