import { describe, expect, it } from 'vitest';

import { computeMetrics } from '../../src/policy/metrics';
import { sampleActionItem } from '../helpers/sampleActionItem';
import type { KanbanComment, KanbanTask } from '../../src/hermes/types';

function card(overrides: { class?: string; primary?: string } = {}): string {
  return JSON.stringify(
    sampleActionItem({
      class: overrides.class ?? 'email:newsletter-unsubscribe',
      options: [
        {
          id: 'unsubscribe',
          label: 'Unsubscribe',
          requires_input: false,
          input_hint: null,
          delivery: null,
          reversibility: 'reversible',
          blast_radius: 'self',
          undo_prompt: 'Resubscribe.',
          execution_prompt: 'Unsubscribe.',
        },
        {
          id: 'archive',
          label: 'Archive',
          requires_input: false,
          input_hint: null,
          delivery: null,
          reversibility: 'reversible',
          blast_radius: 'self',
          undo_prompt: 'Unarchive.',
          execution_prompt: 'Archive.',
        },
      ],
      ui: { primary_option_id: overrides.primary ?? 'unsubscribe', display_group: 'Monitored' },
    }),
  );
}

function comment(body: unknown, created_at = '2026-06-25T08:00:00+10:00'): KanbanComment {
  return { body: JSON.stringify(body), created_at };
}

function silentDecision(created_at?: string): KanbanComment {
  return comment(
    {
      schema: 'keryx.policy_decision.v1',
      selected_option_id: 'unsubscribe',
      disposition: 'silent',
      rule_id: 'r-100',
      reasons: ['active rule r-100 authorizes silent'],
      approved_by: 'keryx-policy',
      approved_via: 'policy:r-100',
      approved_at: created_at ?? '2026-06-25T08:00:00+10:00',
    },
    created_at,
  );
}

function shadowDecision(selected = 'unsubscribe'): KanbanComment {
  return comment({
    schema: 'keryx.policy_decision.v1',
    selected_option_id: selected,
    disposition: 'review',
    rule_id: 'r-100',
    reasons: ['shadow rule r-100: would have run silently'],
    approved_by: 'keryx-policy',
    approved_via: 'policy:shadow:r-100',
    approved_at: '2026-06-25T08:00:00+10:00',
  });
}

function humanDecision(selected: string): KanbanComment {
  return comment({
    schema: 'keryx.execution_decision.v1',
    selected_option_id: selected,
    user_feedback: null,
    approved_by: 'User',
    approved_via: 'keryx-web',
    approved_at: '2026-06-25T09:00:00+10:00',
  });
}

function outcome(): KanbanComment {
  return comment({
    schema: 'keryx.outcome.v1',
    executed_option_id: 'unsubscribe',
    result_summary: 'Unsubscribed.',
    result_delivery: 'digest',
    digest_category: 'Done for you',
    changed_state: 'Removed from mailing list.',
    delivered_via: null,
    completed_at: '2026-06-25T09:30:00+10:00',
  });
}

function regret(kind: 'should_have_acted' | 'should_have_asked'): KanbanComment {
  return comment({
    schema: 'keryx.regret.v1',
    kind,
    note: null,
    recorded_by: 'User',
    recorded_at: '2026-06-25T10:00:00+10:00',
  });
}

function dismissal(): KanbanComment {
  return comment({
    schema: 'keryx.dismissal_decision.v1',
    dismissal_scope: 'exact_item',
    reason: null,
    dismissed_external_id: 'x',
    dismissed_idempotency_key: 'keryx:email:x',
    dismissed_by: 'User',
    dismissed_via: 'keryx-web',
    dismissed_at: '2026-06-25T10:00:00+10:00',
  });
}

function task(id: string, status: string, comments: KanbanComment[]): KanbanTask {
  return { id, status, body: card(), comments };
}

describe('computeMetrics', () => {
  it('tallies decision, outcome, dismissal, and regret comments by kind', () => {
    const metrics = computeMetrics([
      task('t1', 'done', [silentDecision(), outcome()]),
      task('t2', 'done', [humanDecision('unsubscribe')]),
      task('t3', 'done', [humanDecision('archive')]), // override (primary is unsubscribe)
      task('t4', 'archived', [dismissal()]),
    ]);

    expect(metrics.counts.tasks).toBe(4);
    expect(metrics.counts.silentExecutions).toBe(1);
    expect(metrics.counts.humanApprovals).toBe(1);
    expect(metrics.counts.overrides).toBe(1);
    expect(metrics.counts.dismissals).toBe(1);
    expect(metrics.counts.outcomes).toBe(1);
  });

  it('computes override rate from approvals vs overrides', () => {
    const metrics = computeMetrics([
      task('t1', 'done', [humanDecision('unsubscribe')]),
      task('t2', 'done', [humanDecision('unsubscribe')]),
      task('t3', 'done', [humanDecision('unsubscribe')]),
      task('t4', 'done', [humanDecision('archive')]),
    ]);
    expect(metrics.overrideRate).toBeCloseTo(0.25, 5);
  });

  it('computes shadow agreement rate from shadow would-haves later approved unchanged', () => {
    const metrics = computeMetrics([
      // agreement: shadow proposed unsubscribe, human approved unsubscribe
      task('t1', 'done', [shadowDecision('unsubscribe'), humanDecision('unsubscribe')]),
      // disagreement: shadow proposed unsubscribe, human picked archive
      task('t2', 'done', [shadowDecision('unsubscribe'), humanDecision('archive')]),
      // pending shadow with no human decision yet (not counted in the denominator's decided set)
      task('t3', 'blocked', [shadowDecision('unsubscribe')]),
    ]);
    expect(metrics.counts.shadowWouldHave).toBe(3);
    // 1 agreement out of 2 decided shadow cards
    expect(metrics.shadowAgreementRate).toBeCloseTo(0.5, 5);
  });

  it('flags silent failures and recovery cost when a silent card draws a regret', () => {
    const metrics = computeMetrics([
      task('t1', 'done', [silentDecision(), outcome()]),
      task('t2', 'done', [silentDecision(), outcome(), regret('should_have_asked')]),
    ]);
    expect(metrics.counts.silentExecutions).toBe(2);
    expect(metrics.silentFailureCount).toBe(1);
    expect(metrics.recoveryCost).toBe(1);
    // one of two silent cards completed without regret
    expect(metrics.autonomousSafeCompletionRate).toBeCloseTo(0.5, 5);
  });

  it('breaks down escalation regret by kind', () => {
    const metrics = computeMetrics([
      task('t1', 'done', [silentDecision(), regret('should_have_asked')]),
      task('t2', 'blocked', [regret('should_have_acted')]),
      task('t3', 'blocked', [regret('should_have_acted')]),
    ]);
    expect(metrics.counts.regrets).toBe(3);
    expect(metrics.escalationRegret.should_have_acted).toBe(2);
    expect(metrics.escalationRegret.should_have_asked).toBe(1);
  });

  it('filters comments outside the supplied window', () => {
    const metrics = computeMetrics(
      [
        task('t1', 'done', [silentDecision('2026-06-01T00:00:00+10:00')]),
        task('t2', 'done', [silentDecision('2026-06-25T00:00:00+10:00')]),
      ],
      { from: new Date('2026-06-20T00:00:00+10:00') },
    );
    expect(metrics.counts.silentExecutions).toBe(1);
  });

  it('returns null rates when there is no relevant history', () => {
    const metrics = computeMetrics([]);
    expect(metrics.overrideRate).toBeNull();
    expect(metrics.shadowAgreementRate).toBeNull();
    expect(metrics.autonomousSafeCompletionRate).toBeNull();
    expect(metrics.silentFailureCount).toBe(0);
  });
});
