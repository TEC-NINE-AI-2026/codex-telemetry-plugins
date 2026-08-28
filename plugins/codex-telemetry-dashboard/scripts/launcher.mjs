import { createInterface } from 'node:readline/promises';
import { parseAccessModeArgs } from './access-mode.mjs';
import { startDashboard } from './lifecycle.mjs';

async function requestedAccessMode() {
  const explicit = parseAccessModeArgs(process.argv.slice(2));
  if (explicit) return explicit;
  if (!process.stdin.isTTY || !process.stdout.isTTY) return 'local';
  const prompt = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = (await prompt.question('访问模式：1) 仅本机（默认）  2) 允许局域网访问。请选择 [1/2]: ')).trim().toLowerCase();
    return ['2', 'lan', 'y', 'yes'].includes(answer) ? 'lan' : 'local';
  } finally {
    prompt.close();
  }
}

async function main() {
  const accessMode = await requestedAccessMode();
  process.stdout.write(`${JSON.stringify(await startDashboard({ accessMode }))}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
