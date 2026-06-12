import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { loadConfig } from '../../src/config';
import { runOpsctl } from '../../src/opsctl/commands';
import { type ActionItem, validateActionItem } from '../../src/schemas/actionItem';
import type { HermesRunner } from '../../src/hermes/types';

const validActionItem: ActionItem = {
  schema: 'keryx.action_item.v1',
  source: 'email',
  collector: 'keryx-email',
  external_id: 'support-inbox:INBOX:35680',
  idempotency_key: 'keryx:email:support-inbox:INBOX:35680',
  origin_descriptor: 'Support Desk — Account access request',
  title: 'Support request: account access needs review',
  summary: 'Customer reports that account access is failing after a recent change.',
  autonomy: 'auto',
  urgency: 'normal',
  deadline: null,
  risk: 'Support request may stall if ignored.',
  source_refs: [{ type: 'email', account: 'support-inbox', folder: 'INBOX', uid: '35680' }],
  options: [
    {
      id: 'translate_forward_contact_archive',
      label: 'Translate + forward to support contact + archive email',
      requires_input: false,
      input_hint: null,
      delivery: null,
      execution_prompt:
        "Translate the support request into the target language, forward it to the configured support contact, then archive the source email.",
    },
  ],
  ui: { primary_option_id: 'translate_forward_contact_archive', display_group: 'Needs approval' },
  created_at: '2026-05-31T00:00:00+10:00',
};

const validExecutionDecision = {
  schema: 'keryx.execution_decision.v1',
  selected_option_id: 'translate_forward_contact_archive',
  user_feedback: null,
  approved_by: 'User',
  approved_via: 'keryx-web',
  approved_at: '2026-05-31T00:00:00+10:00',
};

describe('read-only opsctl commands', () => {
  it('lists schema, template, and collector-state validation commands in help', async () => {
    const result = await runOpsctl(['--help'], { env: {}, configPath: null });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('schema <action-item|execution-decision|collector-state>');
    expect(result.stdout).toContain('template-card [--source <source>] [--collector <collector>]');
    expect(result.stdout).toContain('validate-state <file>');
    expect(result.stdout).toContain('validate-decision <file>');
  });

  it('validates a valid action-item JSON file', async () => {
    const filePath = writeTempJson(validActionItem);

    const result = await runOpsctl(['validate-card', filePath], { env: {}, configPath: null });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain('OK');
    expect(result.stdout).toContain('Support request');
  });

  it('returns non-zero with validation messages for an invalid action-item JSON file', async () => {
    const malformed = { ...validActionItem } as Record<string, unknown>;
    delete malformed.title;
    const filePath = writeTempJson(malformed);

    const result = await runOpsctl(['validate-card', filePath], { env: {}, configPath: null });

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('FAIL');
    expect(result.stderr).toContain("must have required property 'title'");
  });

  it('validates a valid execution-decision JSON file', async () => {
    const filePath = writeTempJson(validExecutionDecision, 'decision.json');

    const result = await runOpsctl(['validate-decision', filePath], { env: {}, configPath: null });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toBe('OK valid execution decision: translate_forward_contact_archive\n');
  });

  it('returns non-zero with validation messages for an invalid execution-decision JSON file', async () => {
    const malformed = { ...validExecutionDecision } as Record<string, unknown>;
    delete malformed.selected_option_id;
    const filePath = writeTempJson(malformed, 'decision.json');

    const result = await runOpsctl(['validate-decision', filePath], { env: {}, configPath: null });

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain(`FAIL invalid execution decision: ${filePath}`);
    expect(result.stderr).toContain("must have required property 'selected_option_id'");
  });

  it('exits 2 when validate-decision is called without a file path', async () => {
    const result = await runOpsctl(['validate-decision'], { env: {}, configPath: null });

    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('FAIL validate-decision requires a JSON file path');
  });

  it('fails validate-decision with a clear message for unparsable JSON', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'keryx-opsctl-'));
    const filePath = join(directory, 'decision.json');
    writeFileSync(filePath, '{ not valid json', 'utf8');

    const result = await runOpsctl(['validate-decision', filePath], { env: {}, configPath: null });

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('FAIL');
    expect(result.stderr).toContain(`invalid JSON file ${filePath}`);
  });

  it('prints canonical repository schemas exactly', async () => {
    for (const [name, schemaPath] of [
      ['action-item', 'schemas/action-item.v1.schema.json'],
      ['execution-decision', 'schemas/execution-decision.v1.schema.json'],
      ['collector-state', 'schemas/collector-state.v1.schema.json'],
    ] as const) {
      const result = await runOpsctl(['schema', name], { env: {}, configPath: null });

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe('');
      expect(result.stdout).toBe(readFileSync(resolve(schemaPath), 'utf8'));
    }
  });

  it('rejects unknown schema names with a concise usage error', async () => {
    const result = await runOpsctl(['schema', 'unknown'], { env: {}, configPath: null });

    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('FAIL schema requires one of: action-item, execution-decision, collector-state');
  });

  it('validates collector-state JSON files', async () => {
    const filePath = writeTempJson(
      {
        schema: 'keryx.collector_state.v1',
        source: 'email',
        committed_cursor: null,
        last_success_at: null,
        exact_dismissed_external_ids: [],
      },
      'collector-state.json',
    );

    const result = await runOpsctl(['validate-state', filePath], { env: {}, configPath: null });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toBe('OK valid collector state: email\n');
  });

  it('returns non-zero with validation messages for invalid collector state', async () => {
    const filePath = writeTempJson(
      {
        schema: 'keryx.collector_state.v1',
        committed_cursor: null,
        last_success_at: null,
        exact_dismissed_external_ids: [],
      },
      'collector-state.json',
    );

    const result = await runOpsctl(['validate-state', filePath], { env: {}, configPath: null });

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('FAIL invalid collector state');
    expect(result.stderr).toContain("must have required property 'source'");
  });

  it('prints a schema-valid action-item template card', async () => {
    const result = await runOpsctl(['template-card', '--source', 'email', '--collector', 'keryx-email'], {
      env: {},
      configPath: null,
      now: () => new Date('2026-06-11T00:00:00.000Z'),
    });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');

    const parsed = JSON.parse(result.stdout) as ActionItem;
    expect(parsed.source).toBe('email');
    expect(parsed.collector).toBe('keryx-email');
    expect(parsed.idempotency_key).toMatch(/^keryx:email:/);
    expect(parsed.created_at).toBe('2026-06-11T00:00:00.000Z');
    expect(validateActionItem(parsed).ok).toBe(true);
  });

  it('wraps Hermes Kanban list with board, status, and JSON flags', async () => {
    const runner = vi.fn<HermesRunner>(async () => ({
      stdout: JSON.stringify([{ id: 't_1', title: 'Email approval', status: 'blocked', body: JSON.stringify(validActionItem) }]),
      stderr: '',
      exitCode: 0,
    }));

    const result = await runOpsctl(['list', '--status', 'blocked'], {
      config: loadConfig({ env: {}, configPath: null }),
      hermesRunner: runner,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('t_1');
    expect(result.stdout).toContain('Email approval');
    expect(runner).toHaveBeenCalledWith({
      bin: 'hermes',
      args: ['kanban', '--board', 'keryx', 'list', '--status', 'blocked', '--json'],
      env: {},
    });
  });

  it('wraps Hermes Kanban show and validates the task body', async () => {
    const runner = vi.fn<HermesRunner>(async () => ({
      stdout: JSON.stringify({ task: { id: 't_abc', title: 'Show me', status: 'blocked', body: JSON.stringify(validActionItem) } }),
      stderr: '',
      exitCode: 0,
    }));

    const result = await runOpsctl(['show', 't_abc'], {
      config: loadConfig({ env: {}, configPath: null }),
      hermesRunner: runner,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('t_abc');
    expect(result.stdout).toContain('action body: OK');
    expect(runner).toHaveBeenCalledWith({
      bin: 'hermes',
      args: ['kanban', '--board', 'keryx', 'show', 't_abc', '--json'],
      env: {},
    });
  });

  it('summarises only keryx-prefixed cron jobs', async () => {
    const runner = vi.fn<HermesRunner>(async () => ({
      stdout: `
  job_1 [active]
    Name:      keryx-email
    Schedule:  every 10m

  job_2 [active]
    Name:      daily-brief
    Schedule:  0 7 * * *

  job_3 [disabled]
    Name:      keryx-calendar
    Schedule:  every 30m
`,
      stderr: '',
      exitCode: 0,
    }));

    const result = await runOpsctl(['cron-status'], {
      config: loadConfig({ env: {}, configPath: null }),
      hermesRunner: runner,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('keryx-email');
    expect(result.stdout).toContain('enabled');
    expect(result.stdout).toContain('keryx-calendar');
    expect(result.stdout).toContain('disabled');
    expect(result.stdout).not.toContain('daily-brief');
    expect(runner).toHaveBeenCalledWith({ bin: 'hermes', args: ['cron', 'list', '--all'], env: {} });
  });

  it('prints delivery targets as JSON and wraps Hermes send --list --json', async () => {
    const runner = vi.fn<HermesRunner>(async () => ({
      stdout: JSON.stringify({ platforms: { telegram: [{ id: '293041098', name: 'David', type: 'dm', thread_id: null }] } }),
      stderr: '',
      exitCode: 0,
    }));

    const result = await runOpsctl(['delivery-targets', '--json'], {
      config: loadConfig({ env: {}, configPath: null }),
      hermesRunner: runner,
    });

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual([
      { target: 'telegram', label: 'telegram home', platform: 'telegram' },
      { target: 'telegram:293041098', label: 'David', platform: 'telegram' },
    ]);
    expect(runner).toHaveBeenCalledWith({ bin: 'hermes', args: ['send', '--list', '--json'], env: {} });
  });

  it('reports available Hermes delivery targets as a diagnostic in doctor checks', async () => {
    const hermesHome = mkdtempSync(join(tmpdir(), 'keryx-doctor-home-'));
    writeInstalledKeryxPlugin(hermesHome);
    writeHermesPluginConfig(hermesHome, { enabled: ['keryx'] });
    const runner = vi.fn<HermesRunner>(async (request) => {
      if (request.args[0] === '--version') {
        return { stdout: 'Hermes Agent v0.16.0 (2026.6.5) · upstream 046f444d\n', stderr: '', exitCode: 0 };
      }
      if (request.args[0] === 'kanban') {
        return { stdout: JSON.stringify([]), stderr: '', exitCode: 0 };
      }
      if (request.args[0] === 'send') {
        return {
          stdout: JSON.stringify({ platforms: { telegram: [{ id: '293041098', name: 'David', type: 'dm', thread_id: null }] } }),
          stderr: '',
          exitCode: 0,
        };
      }
      if (request.args[0] === 'cron') {
        return { stdout: '', stderr: '', exitCode: 0 };
      }
      throw new Error(`unexpected Hermes args: ${request.args.join(' ')}`);
    });

    const result = await runOpsctl(['doctor'], {
      config: loadConfig({
        env: { HERMES_HOME: hermesHome },
        configPath: null,
        overrides: { hermesBin: process.execPath },
      }),
      env: { HERMES_HOME: hermesHome, PATH: process.env.PATH },
      hermesRunner: runner,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/^OK\s+delivery-targets: 2 target\(s\) available/m);
    expect(result.stdout).not.toMatch(/^(OK|WARN|FAIL)\s+delivery:/m);
  });

  it('emits OK, WARN, and FAIL lines from doctor checks', async () => {
    const runner = vi.fn<HermesRunner>(async () => ({ stdout: '', stderr: 'Hermes unavailable', exitCode: 1 }));

    const result = await runOpsctl(['doctor'], {
      config: loadConfig({ env: {}, configPath: null }),
      hermesRunner: runner,
    });

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toMatch(/^OK\s+config:/m);
    expect(result.stdout).toMatch(/^FAIL\s+hermes:/m);
    expect(result.stdout).not.toMatch(/^(OK|WARN|FAIL)\s+delivery:/m);
  });

  it('fails doctor checks when the Keryx plugin is missing', async () => {
    const hermesHome = mkdtempSync(join(tmpdir(), 'keryx-doctor-home-'));
    const runner = vi.fn<HermesRunner>(async (request) => {
      if (request.args[0] === '--version') {
        return { stdout: 'Hermes Agent v0.16.0 (2026.6.5) · upstream 046f444d\n', stderr: '', exitCode: 0 };
      }
      if (request.args[0] === 'kanban') {
        return { stdout: JSON.stringify([]), stderr: '', exitCode: 0 };
      }
      if (request.args[0] === 'send') {
        return { stdout: JSON.stringify({ platforms: {} }), stderr: '', exitCode: 0 };
      }
      if (request.args[0] === 'cron') {
        return { stdout: '', stderr: '', exitCode: 0 };
      }
      throw new Error(`unexpected Hermes args: ${request.args.join(' ')}`);
    });

    const result = await runOpsctl(['doctor'], {
      config: loadConfig({
        env: { HERMES_HOME: hermesHome },
        configPath: null,
        overrides: { hermesBin: process.execPath },
      }),
      env: { HERMES_HOME: hermesHome, PATH: process.env.PATH },
      hermesRunner: runner,
    });

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toMatch(/^FAIL\s+plugin:/m);
  });

  it('reports OK plugin when installed and listed in plugins.enabled', async () => {
    const hermesHome = mkdtempSync(join(tmpdir(), 'keryx-doctor-home-'));
    writeInstalledKeryxPlugin(hermesHome);
    writeHermesPluginConfig(hermesHome, { enabled: ['keryx'] });

    const result = await runDoctor(hermesHome);

    expect(result.stdout).toMatch(/^OK\s+plugin: installed and enabled/m);
    expect(result.exitCode).toBe(0);
  });

  it('reports OK plugin when enabled via a same-indent block list (Hermes serialiser format)', async () => {
    const hermesHome = mkdtempSync(join(tmpdir(), 'keryx-doctor-home-'));
    writeInstalledKeryxPlugin(hermesHome);
    // Mirrors how Hermes' own config.yaml serialises lists: block items sit at
    // the SAME indentation as their parent key, followed by another top-level key.
    writeFileSync(
      join(hermesHome, 'config.yaml'),
      'plugins:\n  enabled:\n  - keryx\nknown_plugin_toolsets:\n  cli:\n  - spotify\n',
      'utf8',
    );

    const result = await runDoctor(hermesHome);

    expect(result.stdout).toMatch(/^OK\s+plugin: installed and enabled/m);
    expect(result.exitCode).toBe(0);
  });

  it('fails plugin check via a same-indent block disabled list (Hermes serialiser format)', async () => {
    const hermesHome = mkdtempSync(join(tmpdir(), 'keryx-doctor-home-'));
    writeInstalledKeryxPlugin(hermesHome);
    writeFileSync(
      join(hermesHome, 'config.yaml'),
      'plugins:\n  enabled:\n  - keryx\n  disabled:\n  - keryx\n',
      'utf8',
    );

    const result = await runDoctor(hermesHome);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toMatch(/^FAIL\s+plugin: installed but explicitly disabled/m);
  });

  it('fails plugin check when installed but absent from plugins.enabled', async () => {
    const hermesHome = mkdtempSync(join(tmpdir(), 'keryx-doctor-home-'));
    writeInstalledKeryxPlugin(hermesHome);
    writeHermesPluginConfig(hermesHome, { enabled: ['some-other-plugin'] });

    const result = await runDoctor(hermesHome);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toMatch(/^FAIL\s+plugin: installed but not enabled/m);
    expect(result.stdout).toContain('hermes plugins enable keryx');
  });

  it('fails plugin check when explicitly listed in plugins.disabled even if also enabled', async () => {
    const hermesHome = mkdtempSync(join(tmpdir(), 'keryx-doctor-home-'));
    writeInstalledKeryxPlugin(hermesHome);
    writeHermesPluginConfig(hermesHome, { enabled: ['keryx'], disabled: ['keryx'] });

    const result = await runDoctor(hermesHome);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toMatch(/^FAIL\s+plugin: installed but explicitly disabled/m);
    expect(result.stdout).toContain('hermes plugins enable keryx');
  });

  it('fails plugin check when the Hermes config.yaml is missing', async () => {
    const hermesHome = mkdtempSync(join(tmpdir(), 'keryx-doctor-home-'));
    writeInstalledKeryxPlugin(hermesHome);

    const result = await runDoctor(hermesHome);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toMatch(/^FAIL\s+plugin: installed but not enabled/m);
    expect(result.stdout).toContain('hermes plugins enable keryx');
  });

  it('checks setup-installed plugin, dependencies, delivery targets, and collector cron status', async () => {
    const hermesHome = mkdtempSync(join(tmpdir(), 'keryx-doctor-home-'));
    writeInstalledKeryxPlugin(hermesHome);
    writeHermesPluginConfig(hermesHome, { enabled: ['keryx'] });
    const runner = vi.fn<HermesRunner>(async (request) => {
      if (request.args[0] === '--version') {
        return { stdout: 'Hermes Agent v0.16.0 (2026.6.5) · upstream 046f444d\n', stderr: '', exitCode: 0 };
      }
      if (request.args[0] === 'kanban') {
        return {
          stdout: JSON.stringify([{ id: 't_ok', title: 'OK card', status: 'blocked', body: JSON.stringify(validActionItem) }]),
          stderr: '',
          exitCode: 0,
        };
      }
      if (request.args[0] === 'send') {
        return {
          stdout: JSON.stringify({ platforms: { telegram: [{ id: '293041098', name: 'David', type: 'dm', thread_id: null }] } }),
          stderr: '',
          exitCode: 0,
        };
      }
      if (request.args[0] === 'cron') {
        return {
          stdout: `
  job_1 [active]
    Name:      keryx-email
    Schedule:  every 10m
`,
          stderr: '',
          exitCode: 0,
        };
      }
      throw new Error(`unexpected Hermes args: ${request.args.join(' ')}`);
    });

    const result = await runOpsctl(['doctor'], {
      config: loadConfig({
        env: { HERMES_HOME: hermesHome },
        configPath: null,
        overrides: { hermesBin: process.execPath },
      }),
      env: { HERMES_HOME: hermesHome, PATH: process.env.PATH },
      hermesRunner: runner,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/^OK\s+hermes-cli:/m);
    expect(result.stdout).toMatch(/^OK\s+plugin:/m);
    expect(result.stdout).not.toMatch(/^FAIL\s+skills:/m);
    expect(result.stdout).not.toContain('$HERMES_HOME/skills/keryx');
    expect(result.stdout).toMatch(/^OK\s+dependencies:/m);
    expect(result.stdout).toMatch(/^OK\s+hermes:/m);
    expect(result.stdout).toMatch(/^OK\s+delivery-targets:/m);
    expect(result.stdout).not.toMatch(/^(OK|WARN|FAIL)\s+delivery:/m);
    expect(result.stdout).toMatch(/^OK\s+cron:/m);
    expect(runner).toHaveBeenCalledWith({ bin: process.execPath, args: ['send', '--list', '--json'], env: { HERMES_HOME: hermesHome } });
    expect(runner).toHaveBeenCalledWith({ bin: process.execPath, args: ['cron', 'list', '--all'], env: { HERMES_HOME: hermesHome } });
  });

  it('checks project dependencies from the repository root when doctor is invoked outside the repo cwd', async () => {
    const hermesHome = mkdtempSync(join(tmpdir(), 'keryx-doctor-home-'));
    const outsideCwd = mkdtempSync(join(tmpdir(), 'keryx-doctor-outside-cwd-'));
    writeInstalledKeryxPlugin(hermesHome);
    writeHermesPluginConfig(hermesHome, { enabled: ['keryx'] });
    const runner = vi.fn<HermesRunner>(async (request) => {
      if (request.args[0] === '--version') {
        return { stdout: 'Hermes Agent v0.16.0 (2026.6.5) · upstream 046f444d\n', stderr: '', exitCode: 0 };
      }
      if (request.args[0] === 'kanban') {
        return { stdout: JSON.stringify([]), stderr: '', exitCode: 0 };
      }
      if (request.args[0] === 'send') {
        return { stdout: JSON.stringify({ platforms: {} }), stderr: '', exitCode: 0 };
      }
      if (request.args[0] === 'cron') {
        return { stdout: '', stderr: '', exitCode: 0 };
      }
      throw new Error(`unexpected Hermes args: ${request.args.join(' ')}`);
    });

    const result = await runOpsctl(['doctor'], {
      config: loadConfig({
        env: { HERMES_HOME: hermesHome },
        configPath: null,
        overrides: { hermesBin: process.execPath },
      }),
      cwd: outsideCwd,
      env: { HERMES_HOME: hermesHome, PATH: process.env.PATH },
      hermesRunner: runner,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/^OK\s+dependencies: project dependencies installed/m);
    expect(result.stdout).not.toContain('run `npm install` from the Keryx project root');
  });

  it('reports OK hermes-version when the CLI is at the minimum supported version', async () => {
    const hermesHome = mkdtempSync(join(tmpdir(), 'keryx-doctor-home-'));
    writeInstalledKeryxPlugin(hermesHome);
    writeHermesPluginConfig(hermesHome, { enabled: ['keryx'] });

    const result = await runDoctorWithVersion(hermesHome, {
      stdout: 'Hermes Agent v0.16.0 (2026.6.5) · upstream 046f444d\n',
      exitCode: 0,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/^OK\s+hermes-version: 0\.16\.0$/m);
  });

  it('reports OK hermes-version when the CLI is newer than the minimum', async () => {
    const hermesHome = mkdtempSync(join(tmpdir(), 'keryx-doctor-home-'));
    writeInstalledKeryxPlugin(hermesHome);
    writeHermesPluginConfig(hermesHome, { enabled: ['keryx'] });

    const result = await runDoctorWithVersion(hermesHome, {
      stdout: 'Hermes Agent v0.17.2 (2026.7.1) · upstream deadbeef\n',
      exitCode: 0,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/^OK\s+hermes-version: 0\.17\.2$/m);
  });

  it('fails hermes-version when the CLI parses to a version below the minimum', async () => {
    const hermesHome = mkdtempSync(join(tmpdir(), 'keryx-doctor-home-'));
    writeInstalledKeryxPlugin(hermesHome);
    writeHermesPluginConfig(hermesHome, { enabled: ['keryx'] });

    const result = await runDoctorWithVersion(hermesHome, {
      stdout: 'Hermes Agent v0.15.9 (2026.4.1) · upstream cafef00d\n',
      exitCode: 0,
    });

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toMatch(/^FAIL\s+hermes-version:/m);
    expect(result.stdout).toContain('0.15.9');
    expect(result.stdout).toContain('0.16.0');
  });

  it('warns (does not fail) on cosmetically unparsable hermes --version output', async () => {
    const hermesHome = mkdtempSync(join(tmpdir(), 'keryx-doctor-home-'));
    writeInstalledKeryxPlugin(hermesHome);
    writeHermesPluginConfig(hermesHome, { enabled: ['keryx'] });

    const result = await runDoctorWithVersion(hermesHome, {
      stdout: 'Hermes Agent (dev build)\n',
      exitCode: 0,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/^WARN\s+hermes-version:/m);
    expect(result.stdout).not.toMatch(/^FAIL\s+hermes-version:/m);
  });

  it('warns (does not fail) when hermes --version exits non-zero', async () => {
    const hermesHome = mkdtempSync(join(tmpdir(), 'keryx-doctor-home-'));
    writeInstalledKeryxPlugin(hermesHome);
    writeHermesPluginConfig(hermesHome, { enabled: ['keryx'] });

    const result = await runDoctorWithVersion(hermesHome, {
      stdout: '',
      stderr: 'unknown flag --version',
      exitCode: 2,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/^WARN\s+hermes-version:/m);
    expect(result.stdout).not.toMatch(/^FAIL\s+hermes-version:/m);
  });

  it('skips the hermes-version check entirely when the hermes binary is not found', async () => {
    const hermesHome = mkdtempSync(join(tmpdir(), 'keryx-doctor-home-'));
    writeInstalledKeryxPlugin(hermesHome);
    writeHermesPluginConfig(hermesHome, { enabled: ['keryx'] });
    const runner = emptyDoctorRunner();

    const result = await runOpsctl(['doctor'], {
      config: loadConfig({
        env: { HERMES_HOME: hermesHome },
        configPath: null,
        overrides: { hermesBin: '/nonexistent/hermes-binary' },
      }),
      env: { HERMES_HOME: hermesHome, PATH: '' },
      hermesRunner: runner,
    });

    expect(result.stdout).toMatch(/^FAIL\s+hermes-cli:/m);
    expect(result.stdout).not.toMatch(/^(OK|WARN|FAIL)\s+hermes-version:/m);
    expect(runner).not.toHaveBeenCalledWith(expect.objectContaining({ args: ['--version'] }));
  });
});

async function runDoctorWithVersion(
  hermesHome: string,
  version: { stdout: string; stderr?: string; exitCode: number },
) {
  const runner = vi.fn<HermesRunner>(async (request) => {
    if (request.args[0] === '--version') {
      return { stdout: version.stdout, stderr: version.stderr ?? '', exitCode: version.exitCode };
    }
    if (request.args[0] === 'kanban') {
      return { stdout: JSON.stringify([]), stderr: '', exitCode: 0 };
    }
    if (request.args[0] === 'send') {
      return { stdout: JSON.stringify({ platforms: {} }), stderr: '', exitCode: 0 };
    }
    if (request.args[0] === 'cron') {
      return { stdout: '', stderr: '', exitCode: 0 };
    }
    throw new Error(`unexpected Hermes args: ${request.args.join(' ')}`);
  });

  return runOpsctl(['doctor'], {
    config: loadConfig({
      env: { HERMES_HOME: hermesHome },
      configPath: null,
      overrides: { hermesBin: process.execPath },
    }),
    env: { HERMES_HOME: hermesHome, PATH: process.env.PATH },
    hermesRunner: runner,
  });
}

function writeTempJson(value: unknown, fileName = 'card.json'): string {
  const directory = mkdtempSync(join(tmpdir(), 'keryx-opsctl-'));
  const filePath = join(directory, fileName);
  writeFileSync(filePath, JSON.stringify(value), 'utf8');
  return filePath;
}

function writeInstalledKeryxPlugin(hermesHome: string): void {
  const pluginDir = join(hermesHome, 'plugins', 'keryx');
  mkdirSync(pluginDir, { recursive: true });
  writeFileSync(join(pluginDir, 'plugin.yaml'), 'name: keryx\nversion: "0.2.0"\n', 'utf8');
  writeFileSync(join(pluginDir, '__init__.py'), '# test plugin\n', 'utf8');
}

function writeHermesPluginConfig(hermesHome: string, plugins: { enabled?: string[]; disabled?: string[] }): void {
  const sections: string[] = ['plugins:'];
  sections.push(`  enabled: [${(plugins.enabled ?? []).join(', ')}]`);
  if (plugins.disabled) {
    sections.push(`  disabled: [${plugins.disabled.join(', ')}]`);
  }
  writeFileSync(join(hermesHome, 'config.yaml'), `${sections.join('\n')}\n`, 'utf8');
}

function emptyDoctorRunner() {
  return vi.fn<HermesRunner>(async (request) => {
    if (request.args[0] === '--version') {
      return { stdout: 'Hermes Agent v0.16.0 (2026.6.5) · upstream 046f444d\n', stderr: '', exitCode: 0 };
    }
    if (request.args[0] === 'kanban') {
      return { stdout: JSON.stringify([]), stderr: '', exitCode: 0 };
    }
    if (request.args[0] === 'send') {
      return { stdout: JSON.stringify({ platforms: {} }), stderr: '', exitCode: 0 };
    }
    if (request.args[0] === 'cron') {
      return { stdout: '', stderr: '', exitCode: 0 };
    }
    throw new Error(`unexpected Hermes args: ${request.args.join(' ')}`);
  });
}

async function runDoctor(hermesHome: string) {
  return runOpsctl(['doctor'], {
    config: loadConfig({
      env: { HERMES_HOME: hermesHome },
      configPath: null,
      overrides: { hermesBin: process.execPath },
    }),
    env: { HERMES_HOME: hermesHome, PATH: process.env.PATH },
    hermesRunner: emptyDoctorRunner(),
  });
}
