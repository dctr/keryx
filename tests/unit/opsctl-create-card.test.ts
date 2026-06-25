import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { loadConfig } from '../../src/config';
import { runOpsctl } from '../../src/opsctl/commands';
import { sampleActionItem } from '../helpers/sampleActionItem';
import { validatePolicyDecision } from '../../src/schemas/policyDecision';
import type { ActionItem } from '../../src/schemas/actionItem';
import type { HermesRunner } from '../../src/hermes/types';

const validActionItem: ActionItem = sampleActionItem();

const readOnlyActionItem: ActionItem = sampleActionItem({
  class: 'facebook:group-digest',
  external_id: 'facebook:group:42',
  idempotency_key: 'keryx:facebook:group:42',
  options: [
    {
      id: 'summarise_group',
      label: 'Summarise new group posts',
      requires_input: false,
      input_hint: null,
      delivery: null,
      reversibility: 'read_only',
      blast_radius: 'self',
      undo_prompt: null,
      execution_prompt: 'Read the configured Facebook group and summarise new posts since the last run.',
    },
  ],
  ui: { primary_option_id: 'summarise_group', display_group: 'Monitored' },
});

describe('opsctl create-card', () => {
  it('validates an action-item and creates a sticky-blocked Kanban card before assigning a worker', async () => {
    const runner = vi.fn<HermesRunner>(async (request) => ({
      stdout: request.args[3] === 'create' ? JSON.stringify({ id: 't_created', title: validActionItem.title, status: 'ready' }) : '',
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
    expect(JSON.parse(result.stdout)).toEqual({ id: 't_created', title: validActionItem.title, status: 'ready' });
    expect(runner.mock.calls.map(([request]) => request.args)).toEqual([
      [
        'kanban',
        '--board',
        'keryx',
        'create',
        validActionItem.title,
        '--body',
        JSON.stringify(validActionItem),
        '--tenant',
        validActionItem.source,
        '--idempotency-key',
        validActionItem.idempotency_key,
        '--created-by',
        validActionItem.collector,
        '--skill',
        'keryx:keryx-worker',
        '--json',
      ],
      [
        'kanban',
        '--board',
        'keryx',
        'block',
        't_created',
        'approval-required: Keryx candidate awaiting user decision',
      ],
      ['kanban', '--board', 'keryx', 'assign', 't_created', 'default'],
    ]);
    for (const [request] of runner.mock.calls) {
      expect(request.env).toEqual({});
    }
  });

  it('skips the block command when idempotency returns an already-blocked card', async () => {
    const runner = vi.fn<HermesRunner>(async (request) => ({
      stdout: request.args[3] === 'create' ? JSON.stringify({ id: 't_existing', title: validActionItem.title, status: 'blocked' }) : '',
      stderr: '',
      exitCode: 0,
    }));
    const filePath = writeTempJson(validActionItem);

    const result = await runOpsctl(['create-card', filePath], {
      config: loadConfig({ env: {}, configPath: null, overrides: { defaultAssignee: 'default' } }),
      hermesRunner: runner,
    });

    expect(result.exitCode).toBe(0);
    expect(runner.mock.calls.map(([request]) => request.args[3])).toEqual(['create', 'assign']);
    expect(runner.mock.calls.at(1)?.[0].args).toEqual(['kanban', '--board', 'keryx', 'assign', 't_existing', 'default']);
  });

  it('routes a read_only+self card to a silent ready card with a policy-decision comment', async () => {
    const runner = vi.fn<HermesRunner>(async (request) => ({
      stdout:
        request.args[3] === 'create'
          ? JSON.stringify({ id: 't_readonly', title: readOnlyActionItem.title, status: 'blocked' })
          : request.args[3] === 'promote'
            ? JSON.stringify({ id: 't_readonly', status: 'ready' })
            : '',
      stderr: '',
      exitCode: 0,
    }));
    const filePath = writeTempJson(readOnlyActionItem);

    const result = await runOpsctl(['create-card', filePath], {
      config: loadConfig({ env: {}, configPath: null, overrides: { defaultAssignee: 'default' } }),
      hermesRunner: runner,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');

    const verbs = runner.mock.calls.map(([request]) => request.args[3]);
    expect(verbs).toEqual(['create', 'comment', 'promote']);

    const commentArgs = runner.mock.calls[1][0].args;
    expect(commentArgs.slice(0, 5)).toEqual(['kanban', '--board', 'keryx', 'comment', 't_readonly']);
    const decision = JSON.parse(commentArgs[5]) as unknown;
    const validation = validatePolicyDecision(decision);
    expect(validation.ok).toBe(true);
    if (validation.ok) {
      expect(validation.value.disposition).toBe('silent');
      expect(validation.value.rule_id).toBeNull();
      expect(validation.value.approved_via).toBe('policy:read-only');
      expect(validation.value.selected_option_id).toBe('summarise_group');
    }
  });

  it('routes a reversible card with no policy to a blocked review card', async () => {
    const runner = vi.fn<HermesRunner>(async (request) => ({
      stdout: request.args[3] === 'create' ? JSON.stringify({ id: 't_review', title: validActionItem.title, status: 'ready' }) : '',
      stderr: '',
      exitCode: 0,
    }));
    const filePath = writeTempJson(validActionItem);

    const result = await runOpsctl(['create-card', filePath], {
      config: loadConfig({ env: {}, configPath: null, overrides: { defaultAssignee: 'default' } }),
      hermesRunner: runner,
    });

    expect(result.exitCode).toBe(0);
    const verbs = runner.mock.calls.map(([request]) => request.args[3]);
    expect(verbs).toEqual(['create', 'block', 'assign']);
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

  it('rejects a card whose ui.primary_option_id is not an option id before calling Hermes', async () => {
    const runner = vi.fn<HermesRunner>();
    const mismatched = { ...validActionItem, ui: { primary_option_id: 'nonexistent', display_group: 'Needs approval' } };
    const filePath = writeTempJson(mismatched);

    const result = await runOpsctl(['create-card', filePath], {
      config: loadConfig({ env: {}, configPath: null }),
      hermesRunner: runner,
    });

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('FAIL invalid action card');
    expect(result.stderr).toContain('/ui/primary_option_id');
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
