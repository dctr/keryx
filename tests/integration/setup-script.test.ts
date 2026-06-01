import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const repoRoot = resolve('.');
const setupScript = resolve('keryx-setup.sh');
const sourceWorkerSkill = resolve('skills/keryx/keryx-worker/SKILL.md');

interface Harness {
  hermesHome: string;
  configPath: string;
  fakeBin: string;
  logPath: string;
  env: NodeJS.ProcessEnv;
}

describe('keryx setup script', () => {
  it('prints intended actions and writes nothing in dry-run mode', async () => {
    const harness = createHarness();

    const { stdout, stderr } = await runSetup(['--dry-run', '--hermes-home', harness.hermesHome, '--delivery-target', 'telegram'], harness);

    expect(stderr).toBe('');
    expect(stdout).toContain('DRY-RUN');
    expect(stdout).toContain('would create Kanban board keryx');
    expect(stdout).toContain('would install bundled Keryx skills');
    expect(stdout).toContain('would write Keryx config');
    expect(existsSync(join(harness.hermesHome, 'skills', 'keryx'))).toBe(false);
    expect(existsSync(harness.configPath)).toBe(false);
    expect(readLog(harness)).toBe('');
  });

  it('uses the supplied Hermes home, writes delivery-target config, and creates no collector cron jobs', async () => {
    const harness = createHarness();

    const { stdout, stderr } = await runSetup(['--hermes-home', harness.hermesHome, '--delivery-target', 'telegram'], harness);

    expect(stderr).toBe('');
    expect(stdout).toContain('OK setup complete');
    expect(readFileSync(join(harness.hermesHome, 'skills', 'keryx', 'DESCRIPTION.md'), 'utf8')).toContain('Keryx');
    expect(readFileSync(join(harness.hermesHome, 'skills', 'keryx', 'keryx-worker', 'SKILL.md'), 'utf8')).toBe(
      readFileSync(sourceWorkerSkill, 'utf8'),
    );
    expect(statSync(join(harness.hermesHome, 'skills', 'keryx', 'keryx-worker', 'SKILL.md')).isFile()).toBe(true);

    const config = JSON.parse(readFileSync(harness.configPath, 'utf8')) as Record<string, unknown>;
    expect(config).toMatchObject({
      board: 'keryx',
      defaultDeliveryTarget: 'telegram',
      localOnly: false,
      hermesBin: 'hermes',
      host: '127.0.0.1',
      port: 4173,
    });

    const calls = readLog(harness);
    expect(calls).toContain(`${harness.hermesHome}|kanban boards create keryx --name Keryx`);
    expect(calls).toContain(`${harness.hermesHome}|send --list --json`);
    expect(calls).toContain(`${harness.hermesHome}|kanban --board keryx list --status blocked --json`);
    expect(calls).toContain(`${harness.hermesHome}|cron list --all`);
    expect(calls).not.toMatch(/\bcron\s+create\b|\bcronjob\s+create\b|\bcreate\s+cron\b/i);
  });

  it('preserves installed skill files unless --force is passed', async () => {
    const harness = createHarness();
    const installedSkill = join(harness.hermesHome, 'skills', 'keryx', 'keryx-worker', 'SKILL.md');
    mkdirSync(join(harness.hermesHome, 'skills', 'keryx', 'keryx-worker'), { recursive: true });
    writeFileSync(installedSkill, 'custom local skill\n', 'utf8');

    await runSetup(['--hermes-home', harness.hermesHome, '--delivery-target', 'telegram'], harness);
    expect(readFileSync(installedSkill, 'utf8')).toBe('custom local skill\n');

    await runSetup(['--hermes-home', harness.hermesHome, '--delivery-target', 'telegram', '--force'], harness);
    expect(readFileSync(installedSkill, 'utf8')).toBe(readFileSync(sourceWorkerSkill, 'utf8'));
  });

  it('writes local-only config with no default delivery target', async () => {
    const harness = createHarness();

    await runSetup(['--hermes-home', harness.hermesHome, '--local-only'], harness);

    const config = JSON.parse(readFileSync(harness.configPath, 'utf8')) as Record<string, unknown>;
    expect(config.defaultDeliveryTarget).toBeNull();
    expect(config.localOnly).toBe(true);
    expect(readLog(harness)).not.toMatch(/\bcron\s+create\b|\bcronjob\s+create\b|\bcreate\s+cron\b/i);
  });
});

async function runSetup(args: string[], harness: Harness): Promise<{ stdout: string; stderr: string }> {
  const result = await execFileAsync(setupScript, args, {
    cwd: repoRoot,
    env: harness.env,
    timeout: 20_000,
  });
  return { stdout: result.stdout, stderr: result.stderr };
}

function createHarness(): Harness {
  const root = mkdtempSync(join(tmpdir(), 'keryx-setup-test-'));
  const hermesHome = join(root, 'hermes-home');
  const fakeBin = join(root, 'bin');
  const logPath = join(root, 'hermes-calls.log');
  const configPath = join(root, 'keryx.config.json');
  mkdirSync(hermesHome, { recursive: true });
  mkdirSync(fakeBin, { recursive: true });
  writeFileSync(logPath, '', 'utf8');
  writeFakeHermes(join(fakeBin, 'hermes'));

  return {
    hermesHome,
    fakeBin,
    logPath,
    configPath,
    env: {
      ...process.env,
      HERMES_HOME: hermesHome,
      KERYX_CONFIG: configPath,
      FAKE_HERMES_LOG: logPath,
      PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
    },
  };
}

function writeFakeHermes(path: string): void {
  writeFileSync(
    path,
    `#!/usr/bin/env sh
set -eu
printf '%s|%s\n' "\${HERMES_HOME:-}" "$*" >> "\${FAKE_HERMES_LOG:?}"
case "$*" in
  'send --list --json')
    printf '%s\n' '{"targets":[{"target":"telegram","label":"Telegram home","platform":"telegram"}]}'
    ;;
  'kanban boards create keryx --name Keryx')
    printf '%s\n' '{"ok":true,"board":"keryx"}'
    ;;
  'kanban --board keryx list --status blocked --json')
    printf '%s\n' '{"tasks":[]}'
    ;;
  'cron list --all')
    printf '%s\n' '  job_1 [active]'
    printf '%s\n' '    Name:      keryx-email'
    printf '%s\n' '    Schedule:  every 10m'
    ;;
  *)
    printf '%s\n' '{"ok":true}'
    ;;
esac
`,
    'utf8',
  );
  chmodSync(path, 0o755);
}

function readLog(harness: Harness): string {
  if (!existsSync(harness.logPath)) {
    return '';
  }
  return readFileSync(harness.logPath, 'utf8');
}
