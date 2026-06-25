import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { loadConfig } from '../../src/config';
import { runOpsctl } from '../../src/opsctl/commands';
import { sampleActionItem } from '../helpers/sampleActionItem';
import { validatePolicyDecision } from '../../src/schemas/policyDecision';
import type { ActionItem } from '../../src/schemas/actionItem';
import type { HermesRunner, KanbanTask } from '../../src/hermes/types';
import type { Policy } from '../../src/schemas/policy';

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

// A reversible+self card whose silent disposition depends on a policy rule + band.
const stateChangingActionItem: ActionItem = sampleActionItem({
  class: 'email:newsletter-unsubscribe',
  external_id: 'support-inbox:INBOX:99',
  idempotency_key: 'keryx:email:support-inbox:INBOX:99',
  options: [
    {
      id: 'unsubscribe',
      label: 'Unsubscribe',
      requires_input: false,
      input_hint: null,
      delivery: null,
      reversibility: 'reversible',
      blast_radius: 'self',
      undo_prompt: 'Resubscribe to the newsletter.',
      execution_prompt: 'Unsubscribe from the newsletter via the one-click link.',
    },
  ],
  ui: { primary_option_id: 'unsubscribe', display_group: 'Monitored' },
});

function ruleFor(state: 'active' | 'shadow', minConfidence: 'cold' | 'warming' | 'trusted'): Policy {
  return {
    schema: 'keryx.policy.v1',
    collector: 'keryx-email',
    version: 2,
    updated_at: '2026-06-25T09:00:00Z',
    rules: [
      {
        id: 'r-100',
        class: 'email:newsletter-unsubscribe',
        gate: { max_blast_radius: 'self', min_reversibility: 'reversible', min_confidence: minConfidence },
        disposition: 'silent',
        result_delivery: 'digest',
        state,
        approved_by: 'User',
        approved_at: '2026-06-25T09:00:00Z',
        source_card_id: null,
        scope_note: null,
      },
    ],
    thresholds: { spend_requires_approval_always: true },
    track_record: {},
  };
}

function homeWithPolicy(policy: Policy): string {
  const home = mkdtempSync(join(tmpdir(), 'keryx-create-card-home-'));
  const dir = join(home, 'skills', 'keryx-collector-email', 'references');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'policy.json'), JSON.stringify(policy), 'utf8');
  return home;
}

// Builds an approving execution-decision comment, used to manufacture a warming/trusted
// band from the live audit trail for the unsubscribe class.
function approvedTask(id: string): KanbanTask {
  return {
    id,
    status: 'done',
    body: JSON.stringify(stateChangingActionItem),
    comments: [
      {
        body: JSON.stringify({
          schema: 'keryx.execution_decision.v1',
          selected_option_id: 'unsubscribe',
          user_feedback: null,
          approved_by: 'User',
          approved_via: 'keryx-web',
          approved_at: '2026-06-25T08:00:00+10:00',
        }),
      },
    ],
  };
}

function policyAwareRunner(tasks: KanbanTask[]) {
  return vi.fn<HermesRunner>(async (request) => {
    if (request.args[3] === 'list') {
      return { stdout: JSON.stringify(tasks), stderr: '', exitCode: 0 };
    }
    if (request.args[3] === 'create') {
      return { stdout: JSON.stringify({ id: 't_state', title: stateChangingActionItem.title, status: 'ready' }), stderr: '', exitCode: 0 };
    }
    if (request.args[3] === 'promote') {
      return { stdout: JSON.stringify({ id: 't_state', status: 'ready' }), stderr: '', exitCode: 0 };
    }
    return { stdout: '', stderr: '', exitCode: 0 };
  });
}

describe('opsctl create-card policy + band wiring', () => {
  it('routes a state-changing card to silent ready when an active rule and band are satisfied', async () => {
    // 10 approvals + no overrides/regret => trusted band, meeting the rule's min_confidence.
    const home = homeWithPolicy(ruleFor('active', 'trusted'));
    const tasks = Array.from({ length: 10 }, (_, index) => approvedTask(`t_hist_${index}`));
    const runner = policyAwareRunner(tasks);
    const filePath = writeTempJson(stateChangingActionItem);

    const result = await runOpsctl(['create-card', filePath], {
      config: loadConfig({ env: {}, configPath: null, overrides: { defaultAssignee: 'default', hermesHome: home } }),
      hermesRunner: runner,
    });

    expect(result.exitCode).toBe(0);
    const verbs = runner.mock.calls.map(([request]) => request.args[3]);
    expect(verbs).toEqual(['list', 'create', 'comment', 'promote']);
    const decision = JSON.parse(runner.mock.calls[2][0].args[5]) as unknown;
    const validation = validatePolicyDecision(decision);
    expect(validation.ok).toBe(true);
    if (validation.ok) {
      expect(validation.value.disposition).toBe('silent');
      expect(validation.value.rule_id).toBe('r-100');
      expect(validation.value.approved_via).toBe('policy:r-100');
    }
  });

  it('keeps a shadow rule blocked but records a would-have policy decision', async () => {
    const home = homeWithPolicy(ruleFor('shadow', 'trusted'));
    const tasks = Array.from({ length: 10 }, (_, index) => approvedTask(`t_hist_${index}`));
    const runner = policyAwareRunner(tasks);
    const filePath = writeTempJson(stateChangingActionItem);

    const result = await runOpsctl(['create-card', filePath], {
      config: loadConfig({ env: {}, configPath: null, overrides: { defaultAssignee: 'default', hermesHome: home } }),
      hermesRunner: runner,
    });

    expect(result.exitCode).toBe(0);
    const verbs = runner.mock.calls.map(([request]) => request.args[3]);
    // blocked review path with an extra shadow comment after assign
    expect(verbs).toEqual(['list', 'create', 'block', 'assign', 'comment']);
    const decision = JSON.parse(runner.mock.calls[4][0].args[5]) as unknown;
    const validation = validatePolicyDecision(decision);
    expect(validation.ok).toBe(true);
    if (validation.ok) {
      expect(validation.value.disposition).toBe('review');
      expect(validation.value.approved_via).toBe('policy:shadow:r-100');
      expect(validation.value.reasons.join(' ')).toContain('would have');
    }
  });

  it('keeps an active rule blocked when the band is below the gate', async () => {
    // No history => cold band, below the rule's trusted requirement.
    const home = homeWithPolicy(ruleFor('active', 'trusted'));
    const runner = policyAwareRunner([]);
    const filePath = writeTempJson(stateChangingActionItem);

    const result = await runOpsctl(['create-card', filePath], {
      config: loadConfig({ env: {}, configPath: null, overrides: { defaultAssignee: 'default', hermesHome: home } }),
      hermesRunner: runner,
    });

    expect(result.exitCode).toBe(0);
    const verbs = runner.mock.calls.map(([request]) => request.args[3]);
    // no shadow comment: band gate failed, not a shadow rule
    expect(verbs).toEqual(['list', 'create', 'block', 'assign']);
  });
});

