import { homedir } from 'node:os';
import { posix, win32 } from 'node:path';

export function resolveDataRoot(options = {}) {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();
  const pathApi = platform === 'win32' ? win32 : posix;

  if (env.CODEX_TELEMETRY_DATA_DIR) return pathApi.resolve(env.CODEX_TELEMETRY_DATA_DIR);
  if (platform === 'win32') {
    return pathApi.join(env.LOCALAPPDATA || pathApi.join(home, 'AppData', 'Local'), 'CodexTelemetryDashboard');
  }
  if (platform === 'darwin') {
    return pathApi.join(home, 'Library', 'Application Support', 'CodexTelemetryDashboard');
  }
  return pathApi.join(env.XDG_DATA_HOME || pathApi.join(home, '.local', 'share'), 'CodexTelemetryDashboard');
}

export function bundledNodeCandidates(options = {}) {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();
  const pathApi = platform === 'win32' ? win32 : posix;
  const executable = platform === 'win32' ? 'node.exe' : 'node';
  const candidates = [];
  if (env.CODEX_BUNDLED_NODE) candidates.push(pathApi.resolve(env.CODEX_BUNDLED_NODE));
  candidates.push(pathApi.join(home, '.cache', 'codex-runtimes', 'codex-primary-runtime', 'dependencies', 'node', 'bin', executable));
  if (platform === 'darwin') {
    candidates.push(pathApi.join(home, 'Library', 'Caches', 'codex-runtimes', 'codex-primary-runtime', 'dependencies', 'node', 'bin', executable));
  }
  return [...new Set(candidates)];
}

export function sqliteNodeFlags(version = process.versions.node) {
  const [major, minor] = String(version).split('.').map(Number);
  if (major === 22 && minor >= 5 && minor < 13) return ['--experimental-sqlite'];
  if (major === 23 && minor < 4) return ['--experimental-sqlite'];
  return [];
}
