// Attention-economics metrics (PRD §7.9 / §11, D7). A read-side aggregator over the
// Kanban audit trail — no second persistent store. Every figure derives from task
// status plus the validated machine-comment kinds Keryx already writes (policy/execution
// decisions, outcomes, dismissals, regrets). Pure and deterministic so it is unit-tested
// against fixtures and re-derivable at any time.

import type { KanbanComment, KanbanTask } from '../hermes/types';
import { parseCommentBody } from '../hermes/commentBody';
import { validateActionItem } from '../schemas/actionItem';
import { validateDismissalDecision } from '../schemas/dismissalDecision';
import { validateExecutionDecision } from '../schemas/executionDecision';
import { validateOutcome } from '../schemas/outcome';
import { validatePolicyDecision } from '../schemas/policyDecision';
import { validateRegret } from '../schemas/regret';
import { validatorForSchema } from '../schemas/validatorBySchema';

export interface MetricsWindow {
  // Inclusive lower bound; comments older than this are ignored. null = unbounded.
  from?: Date | null;
  // Exclusive upper bound; comments at/after this are ignored. null = unbounded.
  to?: Date | null;
}

export interface MetricsCounts {
  tasks: number;
  silentExecutions: number;
  shadowWouldHave: number;
  humanApprovals: number;
  overrides: number;
  dismissals: number;
  regrets: number;
  outcomes: number;
  interrupts: number;
}

export interface KeryxMetrics {
  window: { from: string | null; to: string | null };
  counts: MetricsCounts;
  // Override rate over decided human reviews (approvals + overrides). null when none.
  overrideRate: number | null;
  // Fraction of decided shadow cards a human later approved exactly as the shadow rule
  // would have. The key promotion-readiness signal. null when no decided shadow cards.
  shadowAgreementRate: number | null;
  // Silent cards reaching `done` without a regret, over all silent cards. null when none.
  autonomousSafeCompletionRate: number | null;
  // Silent cards that drew a regret — the highest-severity signal (§7.9).
  silentFailureCount: number;
  // Regret comments on silent cards — a proxy for undo/correction cost (§7.9).
  recoveryCost: number;
  escalationRegret: { should_have_acted: number; should_have_asked: number };
}

function commentTime(comment: KanbanComment): number | null {
  const value = comment.created_at;
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function inWindow(comment: KanbanComment, from: number | null, to: number | null): boolean {
  if (from === null && to === null) return true;
  const time = commentTime(comment);
  // A comment with no timestamp is kept only when the window is unbounded on both sides.
  if (time === null) return from === null && to === null;
  if (from !== null && time < from) return false;
  if (to !== null && time >= to) return false;
  return true;
}

interface TaskSignals {
  isSilent: boolean;
  shadowSelectedOptionId: string | null;
  humanSelectedOptionIds: string[];
  hasRegret: boolean;
  status: string;
}

export function computeMetrics(tasks: KanbanTask[], window: MetricsWindow = {}): KeryxMetrics {
  const from = window.from ? window.from.getTime() : null;
  const to = window.to ? window.to.getTime() : null;

  const counts: MetricsCounts = {
    tasks: tasks.length,
    silentExecutions: 0,
    shadowWouldHave: 0,
    humanApprovals: 0,
    overrides: 0,
    dismissals: 0,
    regrets: 0,
    outcomes: 0,
    interrupts: 0,
  };

  const escalationRegret = { should_have_acted: 0, should_have_asked: 0 };

  // Decided-review denominators.
  let decidedReviews = 0; // approvals + overrides
  let silentSafeCompletions = 0;
  let silentFailureCount = 0;
  let recoveryCost = 0;
  let shadowDecided = 0;
  let shadowAgreements = 0;

  for (const task of tasks) {
    const card = validateActionItem(parseCommentBody({ body: task.body }));
    const primaryOptionId = card.ok ? (card.value.ui?.primary_option_id ?? null) : null;

    const signals: TaskSignals = {
      isSilent: false,
      shadowSelectedOptionId: null,
      humanSelectedOptionIds: [],
      hasRegret: false,
      status: typeof task.status === 'string' ? task.status : 'unknown',
    };

    for (const comment of task.comments ?? []) {
      if (!inWindow(comment, from, to)) continue;
      const body = parseCommentBody(comment);
      if (body === null) continue;

      // Fast path: dispatch on the body's schema field when present.
      const fastValidator = validatorForSchema(body);
      if (fastValidator !== null) {
        const result = fastValidator(body);
        if (!result.ok) continue;
        const schemaKey = (body as Record<string, unknown>)['schema'] as string;
        if (schemaKey === 'keryx.policy_decision.v1') {
          const policy = validatePolicyDecision(body);
          if (policy.ok) {
            if (policy.value.disposition === 'silent') {
              counts.silentExecutions += 1;
              signals.isSilent = true;
            } else if (policy.value.disposition === 'interrupt') {
              counts.interrupts += 1;
            }
            if (policy.value.approved_via.startsWith('policy:shadow')) {
              counts.shadowWouldHave += 1;
              signals.shadowSelectedOptionId = policy.value.selected_option_id;
            }
          }
        } else if (schemaKey === 'keryx.execution_decision.v1') {
          const execution = validateExecutionDecision(body);
          if (execution.ok) {
            signals.humanSelectedOptionIds.push(execution.value.selected_option_id);
            if (primaryOptionId !== null && execution.value.selected_option_id !== primaryOptionId) {
              counts.overrides += 1;
            } else {
              counts.humanApprovals += 1;
            }
            decidedReviews += 1;
          }
        } else if (schemaKey === 'keryx.dismissal_decision.v1') {
          counts.dismissals += 1;
        } else if (schemaKey === 'keryx.outcome.v1') {
          counts.outcomes += 1;
        } else if (schemaKey === 'keryx.regret.v1') {
          const regret = validateRegret(body);
          if (regret.ok) {
            counts.regrets += 1;
            signals.hasRegret = true;
            escalationRegret[regret.value.kind] += 1;
          }
        }
        continue;
      }

      // Slow path: no schema field — try each validator in sequence.
      const policy = validatePolicyDecision(body);
      if (policy.ok) {
        if (policy.value.disposition === 'silent') {
          counts.silentExecutions += 1;
          signals.isSilent = true;
        } else if (policy.value.disposition === 'interrupt') {
          counts.interrupts += 1;
        }
        // A shadow "would have" record (review disposition, shadow approved_via).
        if (policy.value.approved_via.startsWith('policy:shadow')) {
          counts.shadowWouldHave += 1;
          signals.shadowSelectedOptionId = policy.value.selected_option_id;
        }
        continue;
      }

      const execution = validateExecutionDecision(body);
      if (execution.ok) {
        signals.humanSelectedOptionIds.push(execution.value.selected_option_id);
        if (primaryOptionId !== null && execution.value.selected_option_id !== primaryOptionId) {
          counts.overrides += 1;
        } else {
          counts.humanApprovals += 1;
        }
        decidedReviews += 1;
        continue;
      }

      if (validateDismissalDecision(body).ok) {
        counts.dismissals += 1;
        continue;
      }

      if (validateOutcome(body).ok) {
        counts.outcomes += 1;
        continue;
      }

      const regret = validateRegret(body);
      if (regret.ok) {
        counts.regrets += 1;
        signals.hasRegret = true;
        escalationRegret[regret.value.kind] += 1;
        continue;
      }
    }

    // Task-level rollups.
    if (signals.isSilent) {
      if (signals.hasRegret) {
        silentFailureCount += 1;
        recoveryCost += 1;
      } else if (signals.status === 'done') {
        silentSafeCompletions += 1;
      }
    }

    if (signals.shadowSelectedOptionId !== null && signals.humanSelectedOptionIds.length > 0) {
      shadowDecided += 1;
      if (signals.humanSelectedOptionIds.includes(signals.shadowSelectedOptionId)) {
        shadowAgreements += 1;
      }
    }
  }

  return {
    window: {
      from: window.from ? window.from.toISOString() : null,
      to: window.to ? window.to.toISOString() : null,
    },
    counts,
    overrideRate: decidedReviews > 0 ? counts.overrides / decidedReviews : null,
    shadowAgreementRate: shadowDecided > 0 ? shadowAgreements / shadowDecided : null,
    autonomousSafeCompletionRate: counts.silentExecutions > 0 ? silentSafeCompletions / counts.silentExecutions : null,
    silentFailureCount,
    recoveryCost,
    escalationRegret,
  };
}

// Renders metrics as a compact, stable text block for the `metrics` command. Rates are
// formatted as percentages with one decimal; null rates show as "n/a".
export function formatMetrics(metrics: KeryxMetrics): string {
  const windowLabel =
    metrics.window.from || metrics.window.to
      ? `${metrics.window.from ?? 'beginning'} .. ${metrics.window.to ?? 'now'}`
      : 'all time';

  const rate = (value: number | null): string => (value === null ? 'n/a' : `${(value * 100).toFixed(1)}%`);

  return [
    `keryx metrics (${windowLabel})`,
    '',
    `tasks: ${metrics.counts.tasks}`,
    `silent executions: ${metrics.counts.silentExecutions}`,
    `shadow would-haves: ${metrics.counts.shadowWouldHave}`,
    `human approvals: ${metrics.counts.humanApprovals}`,
    `overrides: ${metrics.counts.overrides}`,
    `dismissals: ${metrics.counts.dismissals}`,
    `outcomes: ${metrics.counts.outcomes}`,
    `interrupts: ${metrics.counts.interrupts}`,
    `regrets: ${metrics.counts.regrets} (should_have_acted=${metrics.escalationRegret.should_have_acted}, should_have_asked=${metrics.escalationRegret.should_have_asked})`,
    '',
    `override rate: ${rate(metrics.overrideRate)}`,
    `shadow agreement rate: ${rate(metrics.shadowAgreementRate)}`,
    `autonomous safe completion rate: ${rate(metrics.autonomousSafeCompletionRate)}`,
    `silent failure count: ${metrics.silentFailureCount}`,
    `recovery cost: ${metrics.recoveryCost}`,
  ].join('\n');
}
