import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { loadConfig } from '../../src/config';
import { runOpsctl } from '../../src/opsctl/commands';
import type { ActionItem } from '../../src/schemas/actionItem';
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

describe('read-only opsctl commands', () => {
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

  it('wraps Hermes Kanban list with board, status, and JSON flags', async () => {
    const runner = vi.fn<HermesRunner>(async () => ({
      stdout: JSON.stringify({ tasks: [{ id: 't_1', title: 'Email approval', status: 'blocked', body: JSON.stringify(validActionItem) }] }),
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
      stdout: JSON.stringify({ targets: [{ target: 'telegram', label: 'Telegram home', platform: 'telegram' }] }),
      stderr: '',
      exitCode: 0,
    }));

    const result = await runOpsctl(['delivery-targets', '--json'], {
      config: loadConfig({ env: {}, configPath: null }),
      hermesRunner: runner,
    });

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual([{ target: 'telegram', label: 'Telegram home', platform: 'telegram' }]);
    expect(runner).toHaveBeenCalledWith({ bin: 'hermes', args: ['send', '--list', '--json'], env: {} });
  });

  it('emits OK, WARN, and FAIL lines from doctor checks', async () => {
    const runner = vi.fn<HermesRunner>(async () => ({ stdout: '', stderr: 'Hermes unavailable', exitCode: 1 }));

    const result = await runOpsctl(['doctor'], {
      config: loadConfig({ env: {}, configPath: null }),
      hermesRunner: runner,
    });

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toMatch(/^OK\s+config:/m);
    expect(result.stdout).toMatch(/^OK\s+delivery:/m);
    expect(result.stdout).toMatch(/^FAIL\s+hermes:/m);
  });

  it('checks setup-installed skills, dependencies, delivery targets, and collector cron status', async () => {
    const hermesHome = mkdtempSync(join(tmpdir(), 'keryx-doctor-home-'));
    writeInstalledKeryxSkills(hermesHome);
    const runner = vi.fn<HermesRunner>(async (request) => {
      if (request.args[0] === 'kanban') {
        return {
          stdout: JSON.stringify({ tasks: [{ id: 't_ok', title: 'OK card', status: 'blocked', body: JSON.stringify(validActionItem) }] }),
          stderr: '',
          exitCode: 0,
        };
      }
      if (request.args[0] === 'send') {
        return {
          stdout: JSON.stringify({ targets: [{ target: 'telegram', label: 'Telegram home', platform: 'telegram' }] }),
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
        overrides: { hermesBin: process.execPath, localOnly: true },
      }),
      env: { HERMES_HOME: hermesHome, PATH: process.env.PATH },
      hermesRunner: runner,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/^OK\s+hermes-cli:/m);
    expect(result.stdout).toMatch(/^OK\s+skills:/m);
    expect(result.stdout).toMatch(/^OK\s+dependencies:/m);
    expect(result.stdout).toMatch(/^OK\s+hermes:/m);
    expect(result.stdout).toMatch(/^OK\s+delivery-targets:/m);
    expect(result.stdout).toMatch(/^OK\s+delivery:/m);
    expect(result.stdout).toMatch(/^OK\s+cron:/m);
    expect(runner).toHaveBeenCalledWith({ bin: process.execPath, args: ['send', '--list', '--json'], env: { HERMES_HOME: hermesHome } });
    expect(runner).toHaveBeenCalledWith({ bin: process.execPath, args: ['cron', 'list', '--all'], env: { HERMES_HOME: hermesHome } });
  });
});

function writeTempJson(value: unknown): string {
  const directory = mkdtempSync(join(tmpdir(), 'keryx-opsctl-'));
  const filePath = join(directory, 'card.json');
  writeFileSync(filePath, JSON.stringify(value), 'utf8');
  return filePath;
}

function writeInstalledKeryxSkills(hermesHome: string): void {
  const requiredFiles = [
    ['DESCRIPTION.md', 'Keryx skills\n'],
    ['keryx-worker/SKILL.md', '---\nname: keryx-worker\ndescription: Worker\n---\n'],
    ['keryx-collector/SKILL.md', '---\nname: keryx-collector\ndescription: Collector\n---\n'],
    ['keryx-collector-creator/SKILL.md', '---\nname: keryx-collector-creator\ndescription: Creator\n---\n'],
  ];

  for (const [relativePath, content] of requiredFiles) {
    const filePath = join(hermesHome, 'skills', 'keryx', relativePath);
    mkdirSync(filePath.split('/').slice(0, -1).join('/'), { recursive: true });
    writeFileSync(filePath, content, 'utf8');
  }
}
