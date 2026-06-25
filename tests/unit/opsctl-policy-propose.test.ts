import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { loadConfig } from '../../src/config';
import { runOpsctl } from '../../src/opsctl/commands';
import { validateActionItem } from '../../src/schemas/actionItem';
import type { HermesRunner } from '../../src/hermes/types';
import type { Policy } from '../../src/schemas/policy';

const proposal: Policy = {
  schema: 'keryx.policy.v1',
  collector: 'keryx-email',
  version: 1,
  updated_at: '2026-06-25T09:00:00Z',
  rules: [
    {
      id: 'r-010',
      class: 'email:newsletter-unsubscribe',
      gate: { max_blast_radius: 'self', min_reversibility: 'reversible', min_confidence: 'trusted' },
      disposition: 'silent',
      result_delivery: 'digest',
      state: 'shadow',
      approved_by: 'User',
      approved_at: '2026-06-25T09:00:00Z',
      source_card_id: null,
      scope_note: 'auto-handle one-click unsubscribes from known senders',
    },
  ],
  thresholds: { spend_requires_approval_always: true },
  track_record: {},
};

function writeTempJson(value: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'keryx-policy-propose-'));
  const path = join(dir, 'proposal.json');
  writeFileSync(path, JSON.stringify(value), 'utf8');
  return path;
}

describe('opsctl policy propose', () => {
  it('creates a blocked human-approval suggestion card from a proposed rule', async () => {
    const created: Record<string, unknown>[] = [];
    const runner = vi.fn<HermesRunner>(async (request) => {
      if (request.args[3] === 'create') {
        created.push({ body: request.args[6] });
        return { stdout: JSON.stringify({ id: 't_proposal', title: 'proposal', status: 'ready' }), stderr: '', exitCode: 0 };
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    });
    const path = writeTempJson(proposal);

    const result = await runOpsctl(['policy', 'propose', path], {
      config: loadConfig({ env: {}, configPath: null, overrides: { defaultAssignee: 'default' } }),
      hermesRunner: runner,
      now: () => new Date('2026-06-26T00:00:00Z'),
    });

    expect(result.exitCode).toBe(0);
    const verbs = runner.mock.calls.map(([request]) => request.args[3]);
    // blocked suggestion card: create -> block -> assign (idempotency returns ready)
    expect(verbs).toEqual(['create', 'block', 'assign']);

    const body = JSON.parse(created[0].body as string) as unknown;
    const validation = validateActionItem(body);
    expect(validation.ok).toBe(true);
    if (validation.ok) {
      expect(validation.value.class).toBe('policy:rule-proposal');
      expect(validation.value.collector).toBe('keryx-email');
      expect(validation.value.proposed_disposition).toBe('review');
      expect(validation.value.idempotency_key).toContain('policy-proposal');
      expect(validation.value.idempotency_key).toContain('r-010');
      // the proposed rule travels in the card so the approving worker can write it
      expect(JSON.stringify(validation.value)).toContain('email:newsletter-unsubscribe');
      const option = validation.value.options[0];
      expect(option.blast_radius).toBe('self');
      expect(option.reversibility).toBe('reversible');
    }
  });

  it('rejects a proposal that is not a valid keryx.policy.v1 document', async () => {
    const runner = vi.fn<HermesRunner>();
    const path = writeTempJson({ schema: 'keryx.policy.v1', collector: 'keryx-email' });

    const result = await runOpsctl(['policy', 'propose', path], {
      config: loadConfig({ env: {}, configPath: null }),
      hermesRunner: runner,
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('FAIL invalid policy proposal');
    expect(runner).not.toHaveBeenCalled();
  });

  it('rejects a proposal with no rules', async () => {
    const runner = vi.fn<HermesRunner>();
    const path = writeTempJson({ ...proposal, rules: [] });

    const result = await runOpsctl(['policy', 'propose', path], {
      config: loadConfig({ env: {}, configPath: null }),
      hermesRunner: runner,
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('FAIL policy propose requires at least one rule');
    expect(runner).not.toHaveBeenCalled();
  });

  it('requires a file path', async () => {
    const result = await runOpsctl(['policy', 'propose'], { env: {}, configPath: null });
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('FAIL policy propose requires a JSON file path');
  });
});
