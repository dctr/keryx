import { accessSync, constants } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const opsctlPath = resolve('bin/opsctl');

describe('opsctl executable', () => {
  it('is executable and prints help without contacting Hermes', async () => {
    accessSync(opsctlPath, constants.X_OK);

    const { stdout, stderr } = await execFileAsync(opsctlPath, ['--help'], { cwd: resolve('.') });

    expect(stderr).toBe('');
    expect(stdout).toContain('Usage: opsctl');
    expect(stdout).toContain('validate-card');
    expect(stdout).toContain('delivery-targets');
  });
});
