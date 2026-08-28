import { spawn } from 'node:child_process';

export function browserCommand(url, platform = process.platform) {
  if (platform === 'win32') return { command: 'explorer.exe', args: [url] };
  if (platform === 'darwin') return { command: 'open', args: [url] };
  return { command: 'xdg-open', args: [url] };
}

export function openBrowser(url, options = {}) {
  const spawnImpl = options.spawnImpl ?? spawn;
  const target = browserCommand(url, options.platform);
  return new Promise((resolvePromise, reject) => {
    const child = spawnImpl(target.command, target.args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolvePromise();
    });
  });
}
