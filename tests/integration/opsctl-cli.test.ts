import { accessSync, chmodSync, constants, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const repoRoot = resolve('.');
const opsctlPath = resolve('bin/opsctl');

describe('opsctl executable', () => {
  it('sets repo-local KERYX_CONFIG by default from any cwd', async () => {
    const harness = createWrapperHarness();

    try {
      const { stdout, stderr } = await execFileAsync(harness.opsctlPath, ['doctor'], {
        cwd: harness.invocationCwd,
        env: envWithoutKeryxConfig(),
        timeout: 20_000,
      });

      expect(stderr).toBe('');
      expect(stdout).toContain(`KERYX_CONFIG=${harness.repoConfigPath}\n`);
      expect(stdout).toContain(`ARGV=${join(harness.repoRoot, 'src/opsctl/cli.ts')} doctor\n`);
    } finally {
      rmSync(harness.root, { recursive: true, force: true });
    }
  });

  it('preserves explicit KERYX_CONFIG when invoked from another cwd', async () => {
    const harness = createWrapperHarness();
    const customConfigPath = join(harness.root, 'custom-keryx.config.json');
    writeFileSync(customConfigPath, '{}\n', 'utf8');

    try {
      const { stdout, stderr } = await execFileAsync(harness.opsctlPath, ['doctor'], {
        cwd: harness.invocationCwd,
        env: { ...envWithoutKeryxConfig(), KERYX_CONFIG: customConfigPath },
        timeout: 20_000,
      });

      expect(stderr).toBe('');
      expect(stdout).toContain(`KERYX_CONFIG=${customConfigPath}\n`);
    } finally {
      rmSync(harness.root, { recursive: true, force: true });
    }
  });

  it('is executable and prints help without contacting Hermes', async () => {
    accessSync(opsctlPath, constants.X_OK);

    const { stdout, stderr } = await execFileAsync(opsctlPath, ['--help'], { cwd: repoRoot });

    expect(stderr).toBe('');
    expect(stdout).toContain('Usage: opsctl');
    expect(stdout).toContain('validate-card');
    expect(stdout).toContain('delivery-targets');
  });
});

interface WrapperHarness {
  root: string;
  repoRoot: string;
  invocationCwd: string;
  opsctlPath: string;
  repoConfigPath: string;
}

function createWrapperHarness(): WrapperHarness {
  const root = mkdtempSync(join(tmpdir(), 'keryx-opsctl-wrapper-'));
  const fakeRepoRoot = join(root, 'repo');
  const binDir = join(fakeRepoRoot, 'bin');
  const fakeTsxDir = join(fakeRepoRoot, 'node_modules', '.bin');
  const invocationCwd = join(root, 'elsewhere');
  mkdirSync(binDir, { recursive: true });
  mkdirSync(fakeTsxDir, { recursive: true });
  mkdirSync(invocationCwd, { recursive: true });

  const harnessOpsctl = join(binDir, 'opsctl');
  writeFileSync(harnessOpsctl, readFileSync(opsctlPath, 'utf8'), 'utf8');
  chmodSync(harnessOpsctl, 0o755);

  const fakeTsx = join(fakeTsxDir, 'tsx');
  writeFileSync(
    fakeTsx,
    `#!/usr/bin/env sh
set -eu
printf 'KERYX_CONFIG=%s\n' "\${KERYX_CONFIG:-}"
printf 'ARGV=%s\n' "$*"
`,
    'utf8',
  );
  chmodSync(fakeTsx, 0o755);

  const repoConfigPath = join(fakeRepoRoot, 'keryx.config.json');
  writeFileSync(repoConfigPath, '{}\n', 'utf8');

  return { root, repoRoot: fakeRepoRoot, invocationCwd, opsctlPath: harnessOpsctl, repoConfigPath };
}

function envWithoutKeryxConfig(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.KERYX_CONFIG;
  return env;
}
