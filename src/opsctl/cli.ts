import { pathToFileURL } from 'node:url';

import { runOpsctl } from './commands';

export async function runCli(argv = process.argv.slice(2)): Promise<void> {
  const result = await runOpsctl(argv);

  if (result.stdout) {
    process.stdout.write(result.stdout);
  }
  if (result.stderr) {
    process.stderr.write(result.stderr);
  }

  process.exitCode = result.exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli().catch((error: unknown) => {
    process.stderr.write(`FAIL ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
