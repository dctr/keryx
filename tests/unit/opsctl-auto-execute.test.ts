import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { loadConfig } from '../../src/config';
import { buildOutcome, runOpsctl } from '../../src/opsctl/commands';
import { validateOutcome } from '../../src/schemas/outcome';
import { validatePolicyDecision } from '../../src/schemas/policyDecision';
import { sampleActionItem } from '../helpers/sampleActionItem';
import type { ActionItem } from '../../src/schemas/actionItem';
import type { HermesRunner } from '../../src/hermes/types';

const readOnlyActionItem: ActionItem = sampleActionItem({
  class: 'facebook:group-digest',
  external_id: 'facebook:group:42',
  idempotency_key: 'keryx:facebook:group:42',
  result_delivery: 'digest',
  digest_category: 'Facebook',
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

const reviewActionItem: ActionItem = sampleActionItem();

describe('opsctl auto-execute', () => {
  it('creates a silent ready card with a policy-decision comment for a read_only card', async () => {
    const runner = vi.fn<HermesRunner>(async (request) => ({
      stdout:
        request.args[3] === 'create'
          ? JSON.stringify({ id: 't_auto', title: readOnlyActionItem.title, status: 'blocked' })
          : request.args[3] === 'promote'
            ? JSON.stringify({ id: 't_auto', status: 'ready' })
            : '',
      stderr: '',
      exitCode: 0,
    }));
    const filePath = writeTempJson(readOnlyActionItem);

    const result = await runOpsctl(['auto-execute', filePath], {
      config: loadConfig({ env: {}, configPath: null, overrides: { defaultAssignee: 'default' } }),
      hermesRunner: runner,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');
    const verbs = runner.mock.calls.map(([request]) => request.args[3]);
    expect(verbs).toEqual(['create', 'comment', 'promote']);
    const decision = JSON.parse(runner.mock.calls[1][0].args[5]) as unknown;
    expect(validatePolicyDecision(decision).ok).toBe(true);
  });

  it('refuses to auto-execute a card that does not resolve to a silent disposition', async () => {
    const runner = vi.fn<HermesRunner>();
    const filePath = writeTempJson(reviewActionItem);

    const result = await runOpsctl(['auto-execute', filePath], {
      config: loadConfig({ env: {}, configPath: null }),
      hermesRunner: runner,
    });

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('FAIL');
    expect(result.stderr).toContain('does not qualify for silent execution');
    expect(result.stderr).toContain('review');
    expect(runner).not.toHaveBeenCalled();
  });

  it('rejects invalid action-item JSON before calling Hermes', async () => {
    const runner = vi.fn<HermesRunner>();
    const malformed = { ...readOnlyActionItem } as Record<string, unknown>;
    delete malformed.title;
    const filePath = writeTempJson(malformed);

    const result = await runOpsctl(['auto-execute', filePath], {
      config: loadConfig({ env: {}, configPath: null }),
      hermesRunner: runner,
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('FAIL invalid action card');
    expect(runner).not.toHaveBeenCalled();
  });

  it('requires a JSON file path', async () => {
    const result = await runOpsctl(['auto-execute'], { env: {}, configPath: null });

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('FAIL auto-execute requires a JSON file path');
  });
});

describe('buildOutcome helper', () => {
  it('builds a schema-valid keryx.outcome.v1 body', () => {
    const outcome = buildOutcome(
      {
        executed_option_id: 'summarise_group',
        result_summary: 'Summarised 3 new posts from the configured group.',
        result_delivery: 'digest',
        digest_category: 'Facebook',
        changed_state: null,
        delivered_via: null,
      },
      () => new Date('2026-06-25T08:00:00+10:00'),
    );

    expect(outcome.schema).toBe('keryx.outcome.v1');
    expect(outcome.completed_at).toBe('2026-06-24T22:00:00.000Z');
    expect(validateOutcome(outcome).ok).toBe(true);
  });
});

function writeTempJson(value: unknown, fileName = 'card.json'): string {
  const directory = mkdtempSync(join(tmpdir(), 'keryx-auto-execute-'));
  const filePath = join(directory, fileName);
  writeFileSync(filePath, JSON.stringify(value), 'utf8');
  return filePath;
}
