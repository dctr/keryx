import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { loadConfig } from '../../src/config';
import type { HermesRunRequest, HermesRunner, KanbanTask } from '../../src/hermes/types';
import { runOpsctl } from '../../src/opsctl/commands';
import { validatePolicy, type Policy } from '../../src/schemas/policy';
import { sampleActionItem } from '../helpers/sampleActionItem';

const collector = 'keryx-email';
const policyRuleClass = 'email:newsletter-unsubscribe';

const newsletterActionItem = sampleActionItem({
  collector,
  class: policyRuleClass,
  external_id: 'imap:INBOX:42',
  idempotency_key: 'keryx:email:imap:INBOX:42',
  options: [
    {
      id: 'unsubscribe_newsletter',
      label: 'Unsubscribe from newsletter',
      requires_input: false,
      input_hint: null,
      delivery: null,
      reversibility: 'reversible',
      blast_radius: 'self',
      undo_prompt: 'Resubscribe to the newsletter.',
      execution_prompt: 'Unsubscribe from this newsletter using the one-click method.',
    },
  ],
  ui: { primary_option_id: 'unsubscribe_newsletter', display_group: 'Monitored' },
});

const shadowPolicy = policyWithRule('shadow');
const activePolicy = policyWithRule('active');

describe('email policy-learning acceptance fixtures', () => {
  it('validates generated policy fixture and keeps silent state-changing rules shadow by default', async () => {
    const policyPath = writeTempJson(shadowPolicy, 'policy.json');

    const validation = validatePolicy(shadowPolicy);
    expect(validation.ok).toBe(true);
    if (!validation.ok) {
      return;
    }

    const silentStateChangingRules = validation.value.rules.filter(
      (rule) => rule.disposition === 'silent' && rule.gate.min_reversibility !== 'read_only',
    );
    expect(silentStateChangingRules.length).toBeGreaterThan(0);
    expect(silentStateChangingRules.every((rule) => rule.state === 'shadow')).toBe(true);

    const result = await runOpsctl(['policy', 'validate', policyPath], { env: {}, configPath: null });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(`OK valid policy: ${collector}`);
  });

  it('creates a blocked review card for newsletter actions when there is no active policy rule', async () => {
    const home = homeWithPolicy(shadowPolicy);
    const cardPath = writeTempJson(newsletterActionItem, 'newsletter-card.json');
    const harness = createHarness([], { createStatus: 'ready' });

    const result = await runOpsctl(['create-card', cardPath], {
      config: loadConfig({ env: {}, configPath: null, overrides: { hermesHome: home, defaultAssignee: 'default' } }),
      hermesRunner: harness.runner,
    });

    expect(result.exitCode).toBe(0);
    expect(harness.verbs()).toEqual(['list', 'create', 'block', 'assign']);
  });

  it('reaches trusted after ten approvals and policy scan preview reports graduation candidate', async () => {
    const home = homeWithPolicy(shadowPolicy);
    const tasks = approvals(10);
    const harness = createHarness(tasks);

    const showResult = await runOpsctl(['policy', 'show', collector, '--json'], {
      config: loadConfig({ env: {}, configPath: null, overrides: { hermesHome: home } }),
      hermesRunner: harness.runner,
    });
    expect(showResult.exitCode).toBe(0);
    const showPayload = JSON.parse(showResult.stdout) as {
      track_record: Record<string, { band: string; approved_since_reset: number }>;
    };
    expect(showPayload.track_record[policyRuleClass]).toMatchObject({ band: 'trusted', approved_since_reset: 10 });

    const previewResult = await runOpsctl(['policy', 'scan', collector, '--preview', '--json'], {
      config: loadConfig({ env: {}, configPath: null, overrides: { hermesHome: home } }),
      hermesRunner: harness.runner,
    });
    expect(previewResult.exitCode).toBe(0);
    const previewPayload = JSON.parse(previewResult.stdout) as {
      proposals: Array<{ kind: string; class: string; currentState: string | null; targetState: string }>;
    };
    expect(previewPayload.proposals).toContainEqual(
      expect.objectContaining({ kind: 'promote', class: policyRuleClass, currentState: 'shadow', targetState: 'active' }),
    );
  });

  it('resets to cold after dismissal and policy scan preview reports no graduation candidate', async () => {
    const home = homeWithPolicy(shadowPolicy);
    const tasks = [...approvals(10), dismissalTask('dismissal-reset')];
    const harness = createHarness(tasks);

    const showResult = await runOpsctl(['policy', 'show', collector, '--json'], {
      config: loadConfig({ env: {}, configPath: null, overrides: { hermesHome: home } }),
      hermesRunner: harness.runner,
    });
    expect(showResult.exitCode).toBe(0);
    const showPayload = JSON.parse(showResult.stdout) as {
      track_record: Record<string, { band: string; approved_since_reset: number; latest_reset: { kind: string } | null }>;
    };
    expect(showPayload.track_record[policyRuleClass]).toMatchObject({
      band: 'cold',
      approved_since_reset: 0,
      latest_reset: { kind: 'dismissal' },
    });

    const previewResult = await runOpsctl(['policy', 'scan', collector, '--preview', '--json'], {
      config: loadConfig({ env: {}, configPath: null, overrides: { hermesHome: home } }),
      hermesRunner: harness.runner,
    });
    expect(previewResult.exitCode).toBe(0);
    const previewPayload = JSON.parse(previewResult.stdout) as {
      proposals: Array<{ kind: string; class: string }>;
    };
    expect(previewPayload.proposals.filter((proposal) => proposal.kind === 'promote' && proposal.class === policyRuleClass)).toEqual([]);
  });

  it('stays warming after three post-dismissal approvals and does not re-graduate yet', async () => {
    const home = homeWithPolicy(shadowPolicy);
    const tasks = [...approvals(10), dismissalTask('dismissal-reset'), ...approvals(3, 'after-reset', '2026-07-05T03:00:00.000Z')];
    const harness = createHarness(tasks);

    const showResult = await runOpsctl(['policy', 'show', collector, '--json'], {
      config: loadConfig({ env: {}, configPath: null, overrides: { hermesHome: home } }),
      hermesRunner: harness.runner,
    });
    expect(showResult.exitCode).toBe(0);
    const showPayload = JSON.parse(showResult.stdout) as {
      track_record: Record<string, { band: string; approved_since_reset: number }>;
    };
    expect(showPayload.track_record[policyRuleClass]).toMatchObject({ band: 'warming', approved_since_reset: 3 });

    const previewResult = await runOpsctl(['policy', 'scan', collector, '--preview', '--json'], {
      config: loadConfig({ env: {}, configPath: null, overrides: { hermesHome: home } }),
      hermesRunner: harness.runner,
    });
    expect(previewResult.exitCode).toBe(0);
    const previewPayload = JSON.parse(previewResult.stdout) as {
      proposals: Array<{ kind: string; class: string }>;
    };
    expect(previewPayload.proposals.filter((proposal) => proposal.kind === 'promote' && proposal.class === policyRuleClass)).toEqual([]);
  });

  it('allows silent create-card flow when active rule exists and band is trusted', async () => {
    const home = homeWithPolicy(activePolicy);
    const cardPath = writeTempJson(newsletterActionItem, 'newsletter-card.json');
    const harness = createHarness(approvals(10));

    const result = await runOpsctl(['create-card', cardPath], {
      config: loadConfig({ env: {}, configPath: null, overrides: { hermesHome: home, defaultAssignee: 'default' } }),
      hermesRunner: harness.runner,
    });

    expect(result.exitCode).toBe(0);
    expect(harness.verbs()).toEqual(['list', 'show', 'show', 'show', 'show', 'show', 'show', 'show', 'show', 'show', 'show', 'create', 'comment', 'promote']);
  });

  it('resets to cold after silent regret and policy scan preview reports demotion candidate', async () => {
    const home = homeWithPolicy(activePolicy);
    const tasks = [...approvals(10), regretTask('silent-regret')];
    const harness = createHarness(tasks);

    const showResult = await runOpsctl(['policy', 'show', collector, '--json'], {
      config: loadConfig({ env: {}, configPath: null, overrides: { hermesHome: home } }),
      hermesRunner: harness.runner,
    });
    expect(showResult.exitCode).toBe(0);
    const showPayload = JSON.parse(showResult.stdout) as {
      track_record: Record<string, { band: string; latest_reset: { kind: string } | null }>;
    };
    expect(showPayload.track_record[policyRuleClass]).toMatchObject({ band: 'cold', latest_reset: { kind: 'regret' } });

    const previewResult = await runOpsctl(['policy', 'scan', collector, '--preview', '--json'], {
      config: loadConfig({ env: {}, configPath: null, overrides: { hermesHome: home } }),
      hermesRunner: harness.runner,
    });
    expect(previewResult.exitCode).toBe(0);
    const previewPayload = JSON.parse(previewResult.stdout) as {
      proposals: Array<{ kind: string; class: string; currentState: string | null; targetState: string }>;
    };
    expect(previewPayload.proposals).toContainEqual(
      expect.objectContaining({ kind: 'demote', class: policyRuleClass, currentState: 'active', targetState: 'revoked' }),
    );
  });

  it('never resolves absolute-floor newsletter actions to silent even with active rule + trusted band', async () => {
    const home = homeWithPolicy(activePolicy);
    const floorCardPath = writeTempJson(
      {
        ...newsletterActionItem,
        idempotency_key: 'keryx:email:imap:INBOX:43',
        options: [
          {
            ...newsletterActionItem.options[0],
            absolute_floor: ['money'],
          },
        ],
      },
      'newsletter-floor-card.json',
    );

    const harness = createHarness(approvals(10), { createStatus: 'ready' });
    const result = await runOpsctl(['create-card', floorCardPath], {
      config: loadConfig({ env: {}, configPath: null, overrides: { hermesHome: home, defaultAssignee: 'default' } }),
      hermesRunner: harness.runner,
    });

    expect(result.exitCode).toBe(0);
    expect(harness.verbs()).toEqual(['list', 'show', 'show', 'show', 'show', 'show', 'show', 'show', 'show', 'show', 'show', 'create', 'block', 'assign']);
  });
});

function policyWithRule(state: 'shadow' | 'active'): Policy {
  return {
    schema: 'keryx.policy.v1',
    collector,
    version: 1,
    updated_at: '2026-07-05T00:00:00.000Z',
    rules: [
      {
        id: 'r-newsletter',
        class: policyRuleClass,
        gate: {
          max_blast_radius: 'self',
          min_reversibility: 'reversible',
          min_confidence: 'trusted',
        },
        disposition: 'silent',
        result_delivery: 'digest',
        state,
        approved_by: 'User',
        approved_at: '2026-07-05T00:00:00.000Z',
        source_card_id: null,
        scope_note: null,
      },
    ],
    thresholds: { spend_requires_approval_always: true },
    track_record: {},
  };
}

function homeWithPolicy(policy: Policy): string {
  const home = mkdtempSync(join(tmpdir(), 'keryx-email-policy-learning-home-'));
  const policyDir = join(home, 'skills', 'keryx-collector-email', 'references');
  mkdirSync(policyDir, { recursive: true });
  writeFileSync(join(policyDir, 'policy.json'), JSON.stringify(policy), 'utf8');
  return home;
}

function writeTempJson(value: unknown, fileName: string): string {
  const directory = mkdtempSync(join(tmpdir(), 'keryx-email-policy-learning-'));
  const filePath = join(directory, fileName);
  writeFileSync(filePath, JSON.stringify(value), 'utf8');
  return filePath;
}

function approvalTask(id: string, createdAt = '2026-07-05T01:00:00.000Z'): KanbanTask {
  return {
    id,
    status: 'done',
    body: JSON.stringify(newsletterActionItem),
    comments: [
      {
        created_at: createdAt,
        body: JSON.stringify({
          schema: 'keryx.execution_decision.v1',
          selected_option_id: 'unsubscribe_newsletter',
          user_feedback: null,
          approved_by: 'User',
          approved_via: 'keryx-web',
          approved_at: '2026-07-05T01:00:00.000Z',
        }),
      },
    ],
  };
}

function approvals(count: number, prefix = 'approval', createdAt = '2026-07-05T01:00:00.000Z'): KanbanTask[] {
  return Array.from({ length: count }, (_, index) => approvalTask(`${prefix}-${index}`, createdAt));
}

function dismissalTask(id: string): KanbanTask {
  return {
    id,
    status: 'done',
    body: JSON.stringify(newsletterActionItem),
    comments: [
      {
        created_at: '2026-07-05T02:00:00.000Z',
        body: JSON.stringify({
          schema: 'keryx.dismissal_decision.v1',
          dismissal_scope: 'exact_item',
          reason: 'wrong target',
          dismissed_external_id: 'imap:INBOX:42',
          dismissed_idempotency_key: 'keryx:email:imap:INBOX:42',
          dismissed_by: 'User',
          dismissed_via: 'keryx-web',
          dismissed_at: '2026-07-05T02:00:00.000Z',
        }),
      },
    ],
  };
}

function regretTask(id: string): KanbanTask {
  return {
    id,
    status: 'done',
    body: JSON.stringify(newsletterActionItem),
    comments: [
      {
        created_at: '2026-07-05T02:30:00.000Z',
        body: JSON.stringify({
          schema: 'keryx.regret.v1',
          kind: 'should_have_asked',
          note: 'Silent unsubscribe should have required review.',
          recorded_by: 'User',
          recorded_at: '2026-07-05T02:30:00.000Z',
        }),
      },
    ],
  };
}

function createHarness(
  tasks: KanbanTask[],
  options: { createStatus?: 'ready' | 'blocked' } = {},
): { runner: HermesRunner; requests: HermesRunRequest[]; verbs: () => string[] } {
  const requests: HermesRunRequest[] = [];
  const createStatus = options.createStatus ?? 'blocked';

  const runner: HermesRunner = async (request) => {
    requests.push(request);
    const command = request.args[3];

    if (command === 'list') {
      const stripped = tasks.map(({ comments: _comments, ...rest }) => rest);
      return { stdout: JSON.stringify(stripped), stderr: '', exitCode: 0 };
    }

    if (command === 'show') {
      const taskId = request.args[4];
      const task = tasks.find((candidate) => candidate.id === taskId);
      if (!task) {
        return { stdout: '', stderr: `No fake task ${taskId}`, exitCode: 1 };
      }
      const { comments = [], ...taskWithoutComments } = task;
      return { stdout: JSON.stringify({ task: taskWithoutComments, comments }), stderr: '', exitCode: 0 };
    }

    if (command === 'create') {
      return { stdout: JSON.stringify({ id: `t_created_${requests.length}`, status: createStatus }), stderr: '', exitCode: 0 };
    }

    if (command === 'promote') {
      return { stdout: JSON.stringify({ ok: true }), stderr: '', exitCode: 0 };
    }

    if (command === 'block' || command === 'assign' || command === 'comment') {
      return { stdout: '', stderr: '', exitCode: 0 };
    }

    return { stdout: '', stderr: `Unhandled command ${request.args.join(' ')}`, exitCode: 1 };
  };

  return {
    runner,
    requests,
    verbs: () => requests.map((request) => request.args[3]),
  };
}
