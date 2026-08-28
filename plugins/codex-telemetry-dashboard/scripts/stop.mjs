import { stopDashboard } from './lifecycle.mjs';

async function main() {
  process.stdout.write(`${JSON.stringify(await stopDashboard())}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
