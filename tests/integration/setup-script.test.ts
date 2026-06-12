import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const repoRoot = resolve('.');
const setupScript = resolve('keryx-setup.sh');
const sourcePluginDir = resolve('hermes-plugin');
const sourcePluginYaml = resolve('hermes-plugin/plugin.yaml');
const sourcePluginInit = resolve('hermes-plugin/__init__.py');

interface Harness {
  hermesHome: string;
  configPath: string;
  fakeBin: string;
  logPath: string;
  env: NodeJS.ProcessEnv;
}

describe('keryx setup script', () => {
  it('prints intended plugin actions and writes nothing in dry-run mode', async () => {
    const harness = createHarness();

    const { stdout, stderr } = await runSetup(['--dry-run', '--hermes-home', harness.hermesHome], harness);

    expect(stderr).toBe('');
    expect(stdout).toContain('DRY-RUN');
    expect(stdout).toContain('would create Kanban board keryx');
    expect(stdout).toContain('would install Keryx Hermes plugin');
    expect(stdout).toContain('would enable Hermes plugin keryx');
    expect(stdout).toContain('would write Keryx config');
    expect(stdout).toContain('would run hermes keryx doctor');
    expect(stdout).not.toContain('would install bundled Keryx skills');
    expect(existsSync(join(harness.hermesHome, 'plugins', 'keryx'))).toBe(false);
    expect(existsSync(join(harness.hermesHome, 'skills', 'keryx'))).toBe(false);
    expect(existsSync(harness.configPath)).toBe(false);
    expect(readLog(harness)).toBe('');
  });

  it('uses the supplied Hermes home, installs and enables the plugin, writes config, and creates no collector cron jobs', async () => {
    const harness = createHarness();

    const { stdout, stderr } = await runSetup(['--hermes-home', harness.hermesHome], harness);

    expect(stderr).toBe('');
    expect(stdout).toContain('OK setup complete');
    const pluginDir = join(harness.hermesHome, 'plugins', 'keryx');
    expect(readFileSync(join(pluginDir, 'plugin.yaml'), 'utf8')).toBe(readFileSync(sourcePluginYaml, 'utf8'));
    expect(readFileSync(join(pluginDir, '__init__.py'), 'utf8')).toBe(readFileSync(sourcePluginInit, 'utf8'));
    expect(lstatSync(pluginDir).isSymbolicLink() || existsSync(join(pluginDir, 'keryx-root.txt'))).toBe(true);
    expect(existsSync(join(harness.hermesHome, 'skills', 'keryx'))).toBe(false);

    const config = JSON.parse(readFileSync(harness.configPath, 'utf8')) as Record<string, unknown>;
    expect(config).toEqual({
      board: 'keryx',
      defaultAssignee: 'default',
      hermesBin: 'hermes',
    });
    for (const field of ['pollIntervalMs', 'defaultDeliveryTarget', 'localOnly', 'host', 'port']) {
      expect(field in config, `setup config should not write removed field ${field}`).toBe(false);
    }

    const calls = readLog(harness);
    expect(calls).toContain(`${harness.hermesHome}|kanban boards create keryx --name Keryx`);
    expect(calls).toContain(`${harness.hermesHome}|plugins enable keryx`);
    expect(calls).toContain(`${harness.hermesHome}|keryx doctor`);
    expect(calls).not.toContain('send --list --json');
    expect(calls).not.toMatch(/\bcron\s+create\b|\bcronjob\s+create\b|\bcreate\s+cron\b/i);
  });

  it('rejects the removed delivery-target and local-only flags', async () => {
    const harness = createHarness();

    const deliveryTargetFailure = await runSetupFailure(['--hermes-home', harness.hermesHome, '--delivery-target', 'telegram'], harness);
    expect(deliveryTargetFailure.code).toBe(2);
    expect(deliveryTargetFailure.stderr).toContain('unknown option: --delivery-target');

    const localOnlyFailure = await runSetupFailure(['--hermes-home', harness.hermesHome, '--local-only'], harness);
    expect(localOnlyFailure.code).toBe(2);
    expect(localOnlyFailure.stderr).toContain('unknown option: --local-only');

    expect(existsSync(harness.configPath)).toBe(false);
  });

  it('preserves an existing symlink to the current plugin source', async () => {
    const harness = createHarness();
    const pluginDir = installedPluginDir(harness);
    mkdirSync(join(harness.hermesHome, 'plugins'), { recursive: true });
    symlinkSync(sourcePluginDir, pluginDir, 'dir');

    const { stdout, stderr } = await runSetup(['--hermes-home', harness.hermesHome], harness);

    expect(stderr).toBe('');
    expect(stdout).toContain('OK plugin symlink already installed');
    expect(readlinkSync(pluginDir)).toBe(sourcePluginDir);
    expect(existsSync(join(pluginDir, 'keryx-root.txt'))).toBe(false);
  });

  it('fails without --force when an existing symlink points elsewhere', async () => {
    const harness = createHarness();
    const pluginDir = installedPluginDir(harness);
    const otherPluginDir = join(harness.hermesHome, 'other-plugin');
    mkdirSync(join(harness.hermesHome, 'plugins'), { recursive: true });
    mkdirSync(otherPluginDir, { recursive: true });
    symlinkSync(otherPluginDir, pluginDir, 'dir');

    const failure = await runSetupFailure(['--hermes-home', harness.hermesHome], harness);

    expect(failure.code).toBe(1);
    expect(failure.stderr).toContain('existing Keryx plugin symlink points elsewhere');
    expect(readlinkSync(pluginDir)).toBe(otherPluginDir);
    expect(existsSync(harness.configPath)).toBe(false);
  });

  it('fails without --force when an existing plugin directory exists', async () => {
    const harness = createHarness();
    const pluginDir = installedPluginDir(harness);
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(join(pluginDir, 'user-file.txt'), 'preserve me\n', 'utf8');

    const failure = await runSetupFailure(['--hermes-home', harness.hermesHome], harness);

    expect(failure.code).toBe(1);
    expect(failure.stderr).toContain('existing Keryx plugin path exists; rerun with --force');
    expect(readFileSync(join(pluginDir, 'user-file.txt'), 'utf8')).toBe('preserve me\n');
    expect(existsSync(harness.configPath)).toBe(false);
  });

  it('replaces a conflicting symlink when --force is supplied', async () => {
    const harness = createHarness();
    const pluginDir = installedPluginDir(harness);
    const otherPluginDir = join(harness.hermesHome, 'other-plugin');
    mkdirSync(join(harness.hermesHome, 'plugins'), { recursive: true });
    mkdirSync(otherPluginDir, { recursive: true });
    symlinkSync(otherPluginDir, pluginDir, 'dir');

    const { stdout, stderr } = await runSetup(['--hermes-home', harness.hermesHome, '--force'], harness);

    expect(stderr).toBe('');
    expect(stdout).toContain('OK installed plugin symlink');
    expect(readlinkSync(pluginDir)).toBe(sourcePluginDir);
  });

  it('replaces a conflicting directory when --force is supplied', async () => {
    const harness = createHarness();
    const pluginDir = installedPluginDir(harness);
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(join(pluginDir, 'user-file.txt'), 'replace me\n', 'utf8');

    const { stdout, stderr } = await runSetup(['--hermes-home', harness.hermesHome, '--force'], harness);

    expect(stderr).toBe('');
    expect(stdout).toContain('OK installed plugin symlink');
    expect(readlinkSync(pluginDir)).toBe(sourcePluginDir);
    expect(existsSync(join(pluginDir, 'user-file.txt'))).toBe(false);
  });

  it('copies the adapter with a root locator only when symlink creation is disabled', async () => {
    const normalHarness = createHarness();
    await runSetup(['--hermes-home', normalHarness.hermesHome], normalHarness);
    const normalPluginDir = installedPluginDir(normalHarness);
    expect(lstatSync(normalPluginDir).isSymbolicLink()).toBe(true);
    expect(existsSync(join(normalPluginDir, 'keryx-root.txt'))).toBe(false);

    const fallbackHarness = createHarness();
    await runSetup(['--hermes-home', fallbackHarness.hermesHome], {
      ...fallbackHarness,
      env: {
        ...fallbackHarness.env,
        KERYX_SETUP_DISABLE_SYMLINK: '1',
      },
    });
    const fallbackPluginDir = installedPluginDir(fallbackHarness);
    expect(lstatSync(fallbackPluginDir).isSymbolicLink()).toBe(false);
    expect(readFileSync(join(fallbackPluginDir, 'plugin.yaml'), 'utf8')).toBe(readFileSync(sourcePluginYaml, 'utf8'));
    expect(readFileSync(join(fallbackPluginDir, '__init__.py'), 'utf8')).toBe(readFileSync(sourcePluginInit, 'utf8'));
    expect(readFileSync(join(fallbackPluginDir, 'keryx-root.txt'), 'utf8')).toBe(`${repoRoot}\n`);
    expect(existsSync(join(fallbackHarness.hermesHome, 'skills', 'keryx'))).toBe(false);
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

async function runSetupFailure(
  args: string[],
  harness: Harness,
): Promise<{ stdout: string; stderr: string; code: unknown }> {
  try {
    const result = await runSetup(args, harness);
    throw new Error(`Expected setup to fail but it succeeded with stdout:\n${result.stdout}`);
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; code?: unknown };
    if (failure.code === undefined) {
      throw error;
    }
    return {
      stdout: failure.stdout ?? '',
      stderr: failure.stderr ?? '',
      code: failure.code,
    };
  }
}

function installedPluginDir(harness: Harness): string {
  return join(harness.hermesHome, 'plugins', 'keryx');
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
    printf '%s\n' '{"platforms":{"telegram":[{"id":"293041098","name":"David","type":"dm","thread_id":null}]}}'
    ;;
  'kanban boards create keryx --name Keryx')
    printf '%s\n' '{"ok":true,"board":"keryx"}'
    ;;
  'kanban --board keryx list --status blocked --json')
    printf '%s\n' '[]'
    ;;
  'cron list --all')
    printf '%s\n' '  job_1 [active]'
    printf '%s\n' '    Name:      keryx-email'
    printf '%s\n' '    Schedule:  every 10m'
    ;;
  'plugins enable keryx')
    printf '%s\n' 'Enabled plugin keryx'
    ;;
  'keryx doctor')
    printf '%s\n' 'OK plugin: installed under fake home'
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
