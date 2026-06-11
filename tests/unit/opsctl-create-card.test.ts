import { mkdtempSync, writeFileSync } from 'node:fs';
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
        'Translate the support request into the target language, forward it to the configured support contact, then archive the source email.',
    },
  ],
  ui: { primary_option_id: 'translate_forward_contact_archive', display_group: 'Needs approval' },
  created_at: '2026-05-31T00:00:00+10:00',
};

describe('opsctl create-card', () => {
  it('validates an action-item and creates a blocked Kanban card through the central Keryx policy', async () => {
    const runner = vi.fn<HermesRunner>(async () => ({
      stdout: JSON.stringify({ id: 't_created', title: validActionItem.title, status: 'blocked' }),
      stderr: '',
      exitCode: 0,
    }));
    const filePath = writeTempJson(validActionItem);

    const result = await runOpsctl(['create-card', filePath], {
      config: loadConfig({ env: {}, configPath: null, overrides: { defaultAssignee: 'default' } }),
      hermesRunner: runner,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toEqual({ id: 't_created', title: validActionItem.title, status: 'blocked' });
    expect(runner).toHaveBeenCalledWith({
      bin: 'hermes',
      args: [
        'kanban',
        '--board',
        'keryx',
        'create',
        validActionItem.title,
        '--body',
        JSON.stringify(validActionItem),
        '--assignee',
        'default',
        '--tenant',
        validActionItem.source,
        '--idempotency-key',
        validActionItem.idempotency_key,
        '--created-by',
        validActionItem.collector,
        '--skill',
        'keryx:keryx-worker',
        '--initial-status',
        'blocked',
        '--json',
      ],
      env: {},
    });
  });

  it('rejects invalid action-item JSON before calling Hermes', async () => {
    const runner = vi.fn<HermesRunner>();
    const malformed = { ...validActionItem } as Record<string, unknown>;
    delete malformed.title;
    const filePath = writeTempJson(malformed);

    const result = await runOpsctl(['create-card', filePath], {
      config: loadConfig({ env: {}, configPath: null }),
      hermesRunner: runner,
    });

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('FAIL invalid action card');
    expect(result.stderr).toContain("must have required property 'title'");
    expect(runner).not.toHaveBeenCalled();
  });

  it('requires a JSON file path', async () => {
    const result = await runOpsctl(['create-card'], { env: {}, configPath: null });

    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('FAIL create-card requires a JSON file path');
  });

  it('forwards explicit Hermes home through the adapter environment', async () => {
    const runner = vi.fn<HermesRunner>(async () => ({
      stdout: JSON.stringify({ id: 't_created', title: validActionItem.title, status: 'blocked' }),
      stderr: '',
      exitCode: 0,
    }));
    const filePath = writeTempJson(validActionItem);

    const result = await runOpsctl(['create-card', filePath], {
      config: loadConfig({
        env: {},
        configPath: null,
        overrides: { defaultAssignee: 'keryx-worker', hermesHome: '/tmp/keryx-hermes-home' },
      }),
      hermesRunner: runner,
    });

    expect(result.exitCode).toBe(0);
    expect(runner).toHaveBeenCalledWith(
      expect.objectContaining({
        env: { HERMES_HOME: '/tmp/keryx-hermes-home' },
      }),
    );
  });

  it('surfaces Hermes command failures as clear FAIL output', async () => {
    const runner = vi.fn<HermesRunner>(async () => ({ stdout: '', stderr: 'no such board', exitCode: 42 }));
    const filePath = writeTempJson(validActionItem);

    const result = await runOpsctl(['create-card', filePath], {
      config: loadConfig({ env: {}, configPath: null }),
      hermesRunner: runner,
    });

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('FAIL Hermes command failed with exit code 42: no such board');
  });
});

function writeTempJson(value: unknown, fileName = 'card.json'): string {
  const directory = mkdtempSync(join(tmpdir(), 'keryx-create-card-'));
  const filePath = join(directory, fileName);
  writeFileSync(filePath, JSON.stringify(value), 'utf8');
  return filePath;
}
