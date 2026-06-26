import { describe, expect, it, vi } from 'vitest';

import { loadConfig } from '../../src/config';
import { runOpsctl } from '../../src/opsctl/commands';
import {
  buildAutoResolutionOutcome,
  findResolvableInterrupts,
  resolveTimeoutDeadline,
} from '../../src/opsctl/defaultResolver';
import { validateOutcome } from '../../src/schemas/outcome';
import { sampleActionItem } from '../helpers/sampleActionItem';
import type { ActionItem, DefaultOnTimeout } from '../../src/schemas/actionItem';
import type { HermesRunner, KanbanComment, KanbanTask } from '../../src/hermes/types';

const NOW = new Date('2026-06-26T12:00:00.000Z');
const CREATED_AT = '2026-06-26T09:00:00+00:00';

// A schema-valid interrupt-tier card (interrupt requires default_on_timeout, and an
// execute_option default must reference a real option id).
function interruptCard(timeout: DefaultOnTimeout, overrides: Partial<ActionItem> = {}): ActionItem {
  return sampleActionItem({
    urgency: 'urgent',
    proposed_disposition: 'interrupt',
    risk: 'The customer escalates if this is ignored.',
    default_on_timeout: timeout,
    created_at: CREATED_AT,
    ...overrides,
  });
}

function task(id: string, card: ActionItem, comments: KanbanComment[] = [], status = 'blocked'): KanbanTask {
  return { id, status, body: JSON.stringify(card), comments };
}

describe('resolveTimeoutDeadline', () => {
  it('resolves an ISO-8601 duration relative to the card creation time', () => {
    expect(resolveTimeoutDeadline('PT2H', CREATED_AT)?.toISOString()).toBe('2026-06-26T11:00:00.000Z');
    expect(resolveTimeoutDeadline('PT1H30M', CREATED_AT)?.toISOString()).toBe('2026-06-26T10:30:00.000Z');
    expect(resolveTimeoutDeadline('P1D', CREATED_AT)?.toISOString()).toBe('2026-06-27T09:00:00.000Z');
  });

  it('resolves an absolute ISO-8601 timestamp', () => {
    expect(resolveTimeoutDeadline('2026-06-26T10:00:00+00:00', CREATED_AT)?.toISOString()).toBe(
      '2026-06-26T10:00:00.000Z',
    );
  });

  it('returns null for a deadline it cannot determine deterministically', () => {
    // Bare wall-clock times and garbage are display-only; the resolver never guesses.
    expect(resolveTimeoutDeadline('15:00', CREATED_AT)).toBeNull();
    expect(resolveTimeoutDeadline('soon', CREATED_AT)).toBeNull();
    expect(resolveTimeoutDeadline('', CREATED_AT)).toBeNull();
    expect(resolveTimeoutDeadline('P', CREATED_AT)).toBeNull();
  });
});

describe('findResolvableInterrupts', () => {
  it('selects expired, undecided interrupt cards and skips everything else', () => {
    const expiredExecute = task('t_exec', interruptCard({ action: 'execute_option', option_id: 'translate_forward_contact_archive', after: 'PT2H' }));
    const expiredDismiss = task('t_dismiss', interruptCard({ action: 'dismiss', after: '2026-06-26T10:00:00+00:00' }));
    const notYetExpired = task('t_fresh', interruptCard({ action: 'dismiss', after: 'PT6H' }));
    const notInterrupt = task('t_review', sampleActionItem({ created_at: CREATED_AT }));

    const resolvable = findResolvableInterrupts([expiredExecute, expiredDismiss, notYetExpired, notInterrupt], NOW);

    expect(resolvable.map((item) => item.task.id).sort()).toEqual(['t_dismiss', 't_exec']);
  });

  it('skips a card that already carries a human decision', () => {
    const executionDecision: KanbanComment = {
      body: JSON.stringify({
        schema: 'keryx.execution_decision.v1',
        selected_option_id: 'translate_forward_contact_archive',
        user_feedback: null,
        approved_by: 'User',
        approved_via: 'keryx-web',
        approved_at: '2026-06-26T11:30:00.000Z',
      }),
    };
    const decided = task('t_decided', interruptCard({ action: 'dismiss', after: 'PT2H' }), [executionDecision]);

    expect(findResolvableInterrupts([decided], NOW)).toEqual([]);
  });

  it('skips a card that was already auto-resolved (dedupe via delivered_via marker)', () => {
    const priorOutcome: KanbanComment = {
      body: JSON.stringify({
        schema: 'keryx.outcome.v1',
        executed_option_id: 'dismiss',
        result_summary: 'Auto-resolved on interrupt timeout: dismissed.',
        result_delivery: 'log_only',
        digest_category: null,
        changed_state: 'auto-dismissed; card archived',
        delivered_via: 'keryx-default-resolver',
        completed_at: '2026-06-26T11:45:00.000Z',
      }),
    };
    const alreadyResolved = task('t_done', interruptCard({ action: 'dismiss', after: 'PT2H' }), [priorOutcome]);

    expect(findResolvableInterrupts([alreadyResolved], NOW)).toEqual([]);
  });
});

describe('buildAutoResolutionOutcome', () => {
  it('builds a schema-valid log_only outcome for an execute_option default', () => {
    const item = findResolvableInterrupts(
      [task('t_exec', interruptCard({ action: 'execute_option', option_id: 'translate_forward_contact_archive', after: 'PT2H' }))],
      NOW,
    )[0];

    const outcome = buildAutoResolutionOutcome(item, () => NOW);

    expect(validateOutcome(outcome).ok).toBe(true);
    expect(outcome.executed_option_id).toBe('translate_forward_contact_archive');
    expect(outcome.result_delivery).toBe('log_only');
    expect(outcome.delivered_via).toBe('keryx-default-resolver');
    expect(outcome.completed_at).toBe('2026-06-26T12:00:00.000Z');
  });

  it('builds a schema-valid outcome for a dismiss default', () => {
    const item = findResolvableInterrupts([task('t_dismiss', interruptCard({ action: 'dismiss', after: 'PT2H' }))], NOW)[0];

    const outcome = buildAutoResolutionOutcome(item, () => NOW);

    expect(validateOutcome(outcome).ok).toBe(true);
    expect(outcome.executed_option_id).toBe('dismiss');
    expect(outcome.changed_state).toContain('dismiss');
  });
});

describe('opsctl default-resolve command', () => {
  // Models the live two-call contract: `list --json` omits per-task comments; only
  // `show --json` embeds them. default-resolve enriches via show before reading comments.
  function boardRunner(tasks: KanbanTask[]): ReturnType<typeof vi.fn<HermesRunner>> {
    return vi.fn<HermesRunner>(async (request) => {
      if (request.args[3] === 'list') {
        const stripped = tasks.map(({ comments: _comments, ...rest }) => rest);
        return { stdout: JSON.stringify(stripped), stderr: '', exitCode: 0 };
      }
      if (request.args[3] === 'show') {
        const task = tasks.find((candidate) => candidate.id === request.args[4]);
        return task
          ? { stdout: JSON.stringify({ task }), stderr: '', exitCode: 0 }
          : { stdout: '', stderr: `No fake task ${request.args[4]}`, exitCode: 1 };
      }
      if (request.args[3] === 'promote') {
        return { stdout: JSON.stringify({ id: request.args[4], status: 'ready' }), stderr: '', exitCode: 0 };
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    });
  }

  it('auto-executes an expired execute_option interrupt: outcome + execution decision + promote', async () => {
    const card = interruptCard({ action: 'execute_option', option_id: 'translate_forward_contact_archive', after: 'PT2H' });
    const runner = boardRunner([task('t_exec', card)]);

    const result = await runOpsctl(['default-resolve'], {
      config: loadConfig({ env: {}, configPath: null }),
      hermesRunner: runner,
      now: () => NOW,
    });

    expect(result.exitCode).toBe(0);
    const verbs = runner.mock.calls.map(([request]) => request.args[3]);
    expect(verbs).toEqual(['list', 'show', 'comment', 'comment', 'promote']);

    const comments = runner.mock.calls.filter(([request]) => request.args[3] === 'comment').map(([request]) => JSON.parse(request.args[5]));
    const outcome = comments.find((body) => body.schema === 'keryx.outcome.v1');
    const decision = comments.find((body) => body.schema === 'keryx.execution_decision.v1');
    expect(validateOutcome(outcome).ok).toBe(true);
    expect(decision.selected_option_id).toBe('translate_forward_contact_archive');
    expect(decision.approved_by).toBe('keryx-default-resolver');
    expect(decision.approved_via).toBe('keryx-default-resolver');

    const summary = JSON.parse(result.stdout);
    expect(summary.resolved).toEqual([
      { task_id: 't_exec', action: 'execute_option', option_id: 'translate_forward_contact_archive', status: 'ready' },
    ]);
  });

  it('auto-dismisses an expired dismiss interrupt: outcome + dismissal + archive', async () => {
    const card = interruptCard({ action: 'dismiss', after: '2026-06-26T10:00:00+00:00' });
    const runner = boardRunner([task('t_dismiss', card)]);

    const result = await runOpsctl(['default-resolve'], {
      config: loadConfig({ env: {}, configPath: null }),
      hermesRunner: runner,
      now: () => NOW,
    });

    expect(result.exitCode).toBe(0);
    const verbs = runner.mock.calls.map(([request]) => request.args[3]);
    expect(verbs).toEqual(['list', 'show', 'comment', 'comment', 'archive']);

    const comments = runner.mock.calls.filter(([request]) => request.args[3] === 'comment').map(([request]) => JSON.parse(request.args[5]));
    const dismissal = comments.find((body) => body.schema === 'keryx.dismissal_decision.v1');
    expect(dismissal.dismissed_by).toBe('keryx-default-resolver');
    expect(dismissal.dismissed_external_id).toBe(card.external_id);

    const summary = JSON.parse(result.stdout);
    expect(summary.resolved).toEqual([{ task_id: 't_dismiss', action: 'dismiss', status: 'archived' }]);
  });

  it('does nothing (no mutations) when no interrupts have expired', async () => {
    const runner = boardRunner([task('t_fresh', interruptCard({ action: 'dismiss', after: 'PT6H' }))]);

    const result = await runOpsctl(['default-resolve'], {
      config: loadConfig({ env: {}, configPath: null }),
      hermesRunner: runner,
      now: () => NOW,
    });

    expect(result.exitCode).toBe(0);
    // list once + enrich the single card via show; no mutations beyond that.
    expect(runner.mock.calls.map(([request]) => request.args[3])).toEqual(['list', 'show']);
    expect(JSON.parse(result.stdout).resolved).toEqual([]);
  });

  it('--preview plans the resolutions without mutating any card', async () => {
    const runner = boardRunner([
      task('t_exec', interruptCard({ action: 'execute_option', option_id: 'translate_forward_contact_archive', after: 'PT2H' })),
    ]);

    const result = await runOpsctl(['default-resolve', '--preview'], {
      config: loadConfig({ env: {}, configPath: null }),
      hermesRunner: runner,
      now: () => NOW,
    });

    expect(result.exitCode).toBe(0);
    // list once + enrich the single card via show; --preview makes no mutations.
    expect(runner.mock.calls.map(([request]) => request.args[3])).toEqual(['list', 'show']);
    const summary = JSON.parse(result.stdout);
    expect(summary.resolved).toEqual([
      { task_id: 't_exec', action: 'execute_option', option_id: 'translate_forward_contact_archive', status: 'planned' },
    ]);
  });
});
