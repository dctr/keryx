import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { loadConfig } from '../../src/config';
import { runOpsctl } from '../../src/opsctl/commands';
import type { HermesRunner, KanbanTask } from '../../src/hermes/types';
import type { ActionItem } from '../../src/schemas/actionItem';
import type { Policy } from '../../src/schemas/policy';

function tempHome(): string {
  return mkdtempSync(join(tmpdir(), 'keryx-policy-apply-'));
}

function writePolicy(home: string, policy: Policy): string {
  const source = policy.collector.startsWith('keryx-') ? policy.collector.slice('keryx-'.length) : policy.collector;
  const dir = join(home, 'skills', `keryx-collector-${source}`, 'references');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'policy.json');
  writeFileSync(path, JSON.stringify(policy), 'utf8');
  return path;
}

function policyBody(className: ActionItem['class']): ActionItem {
  return {
    schema: 'keryx.action_item.v2',
    source: 'email',
    collector: 'keryx-email',
    class: className,
    external_id: `policy:${className}:email`,
    idempotency_key: `keryx:policy:${className}:email`,
    origin_descriptor: 'policy proposal',
    title: 'Policy proposal',
    summary: 'Apply policy proposal',
    urgency: 'normal',
    proposed_disposition: 'review',
    source_refs: [
      {
        type: 'policy-rule-data',
        collector: 'keryx-email',
        rule_id: 'r-apply',
        class: 'email:newsletter-unsubscribe',
        state: 'active',
        disposition: 'silent',
        result_delivery: 'digest',
        gate_max_blast_radius: 'self',
        gate_min_reversibility: 'reversible',
        gate_min_confidence: 'trusted',
        source_card_id: null,
        scope_note: null,
      },
      {
        type: 'policy-rule',
        collector: 'keryx-email',
        rule_id: 'r-apply',
        class: 'email:newsletter-unsubscribe',
        state: 'active',
        disposition: 'silent',
      },
    ],
    options: [
      {
        id: 'approve_rule',
        label: 'Apply policy proposal',
        requires_input: false,
        input_hint: null,
        delivery: null,
        reversibility: 'reversible',
        blast_radius: 'self',
        undo_prompt: 'Run policy revoke',
        execution_prompt: 'Run hermes keryx policy apply <task_id>.',
      },
    ],
    ui: { primary_option_id: 'approve_rule', display_group: 'Policy proposals' },
    created_at: '2026-07-05T00:00:00.000Z',
  };
}

function policyTask(overrides: Partial<KanbanTask> = {}): KanbanTask {
  return {
    id: 't_policy',
    status: 'blocked',
    body: JSON.stringify(policyBody('policy:rule-proposal')),
    comments: [
      {
        created_at: '2026-07-05T12:01:00.000Z',
        body: JSON.stringify({
          schema: 'keryx.execution_decision.v1',
          selected_option_id: 'approve_rule',
          user_feedback: null,
          approved_by: 'User',
          approved_via: 'keryx-web',
          approved_at: '2026-07-05T12:01:00.000Z',
        }),
      },
    ],
    ...overrides,
  };
}

const basePolicy: Policy = {
  schema: 'keryx.policy.v1',
  collector: 'keryx-email',
  version: 1,
  updated_at: '2026-07-05T12:00:00.000Z',
  rules: [],
  thresholds: { spend_requires_approval_always: true },
  track_record: {},
};

function applyRunner(task: KanbanTask, comments: string[]): HermesRunner {
  return vi.fn<HermesRunner>(async (request) => {
    const verb = request.args[3];
    if (verb === 'show') {
      return { stdout: JSON.stringify({ task: { ...task, comments: undefined }, comments: task.comments ?? [] }), stderr: '', exitCode: 0 };
    }
    if (verb === 'comment') {
      comments.push(request.args[5]);
      return { stdout: '', stderr: '', exitCode: 0 };
    }
    if (verb === 'complete') {
      return { stdout: '', stderr: '', exitCode: 0 };
    }
    return { stdout: '', stderr: `unexpected command: ${request.args.join(' ')}`, exitCode: 1 };
  });
}

describe('opsctl policy apply', () => {
  it('applies an approved policy proposal deterministically, writes policy, comments outcome, and completes task', async () => {
    const home = tempHome();
    const policyPath = writePolicy(home, basePolicy);
    const task = policyTask();
    const commentBodies: string[] = [];
    const runner = applyRunner(task, commentBodies);

    const result = await runOpsctl(['policy', 'apply', task.id], {
      config: loadConfig({ env: {}, configPath: null, overrides: { hermesHome: home } }),
      hermesRunner: runner,
      now: () => new Date('2026-07-06T00:00:00.000Z'),
    });

    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout) as { version: number; task_id: string; path: string };
    expect(payload.task_id).toBe('t_policy');
    expect(payload.version).toBe(2);
    expect(payload.path).toBe(policyPath);

    const policy = JSON.parse(readFileSync(policyPath, 'utf8')) as Policy;
    expect(policy.version).toBe(2);
    expect(policy.rules).toHaveLength(1);
    expect(policy.rules[0]).toMatchObject({
      id: 'r-apply',
      class: 'email:newsletter-unsubscribe',
      state: 'active',
      approved_by: 'User',
      source_card_id: 't_policy',
    });

    expect(commentBodies).toHaveLength(1);
    expect(JSON.parse(commentBodies[0])).toMatchObject({
      schema: 'keryx.outcome.v1',
      executed_option_id: 'approve_rule',
      delivered_via: 'keryx-policy-apply',
    });

    const verbs = (runner as ReturnType<typeof vi.fn>).mock.calls.map(([request]) => request.args[3]);
    expect(verbs).toEqual(['show', 'comment', 'complete']);
  });

  it('fails when there is no trusted human execution decision', async () => {
    const home = tempHome();
    writePolicy(home, basePolicy);
    const task = policyTask({
      comments: [
        {
          body: JSON.stringify({
            schema: 'keryx.execution_decision.v1',
            selected_option_id: 'approve_rule',
            user_feedback: null,
            approved_by: 'keryx-policy',
            approved_via: 'policy:r-001',
            approved_at: '2026-07-05T12:01:00.000Z',
          }),
        },
      ],
    });

    const result = await runOpsctl(['policy', 'apply', task.id], {
      config: loadConfig({ env: {}, configPath: null, overrides: { hermesHome: home } }),
      hermesRunner: applyRunner(task, []),
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('missing a trusted human keryx.execution_decision.v1');
  });

  it('applies demotion and revocation proposals deterministically', async () => {
    const home = tempHome();
    const policyPath = writePolicy(home, {
      ...basePolicy,
      rules: [
        {
          id: 'r-apply',
          class: 'email:newsletter-unsubscribe',
          gate: { max_blast_radius: 'self', min_reversibility: 'reversible', min_confidence: 'trusted' },
          disposition: 'silent',
          result_delivery: 'digest',
          state: 'active',
          approved_by: 'User',
          approved_at: '2026-07-05T12:00:00.000Z',
          source_card_id: null,
          scope_note: null,
        },
      ],
    });

    const demotionTask = policyTask({ body: JSON.stringify(policyBody('policy:rule-demotion')) });
    const demotionResult = await runOpsctl(['policy', 'apply', demotionTask.id], {
      config: loadConfig({ env: {}, configPath: null, overrides: { hermesHome: home } }),
      hermesRunner: applyRunner(demotionTask, []),
      now: () => new Date('2026-07-06T01:00:00.000Z'),
    });
    expect(demotionResult.exitCode).toBe(0);

    const demotedPolicy = JSON.parse(readFileSync(policyPath, 'utf8')) as Policy;
    expect(demotedPolicy.rules[0].state).toBe('shadow');

    const revocationCard = policyBody('policy:rule-revocation');
    revocationCard.options[0].id = 'revoke_rule';
    revocationCard.ui = { primary_option_id: 'revoke_rule', display_group: 'Policy proposals' };
    const revocationTask = policyTask({
      body: JSON.stringify(revocationCard),
      comments: [
        {
          body: JSON.stringify({
            schema: 'keryx.execution_decision.v1',
            selected_option_id: 'revoke_rule',
            user_feedback: null,
            approved_by: 'User',
            approved_via: 'keryx-web',
            approved_at: '2026-07-05T12:01:00.000Z',
          }),
        },
      ],
    });

    const revokeResult = await runOpsctl(['policy', 'apply', revocationTask.id], {
      config: loadConfig({ env: {}, configPath: null, overrides: { hermesHome: home } }),
      hermesRunner: applyRunner(revocationTask, []),
      now: () => new Date('2026-07-06T02:00:00.000Z'),
    });
    expect(revokeResult.exitCode).toBe(0);

    const revokedPolicy = JSON.parse(readFileSync(policyPath, 'utf8')) as Policy;
    expect(revokedPolicy.rules).toEqual([]);
  });
});
