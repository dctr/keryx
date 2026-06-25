import { describe, expect, it, vi } from 'vitest';

import { loadConfig } from '../../src/config';
import { runOpsctl } from '../../src/opsctl/commands';
import { sampleActionItem, sampleActionOption } from '../helpers/sampleActionItem';
import type { HermesRunner, KanbanComment, KanbanTask } from '../../src/hermes/types';
import type { ActionOption } from '../../src/schemas/actionItem';

const now = () => new Date('2026-06-26T09:00:00.000Z');

// Build a done card whose executed option is `option`, recording the execution via a
// trusted decision/outcome comment so `undo` can discover what actually ran.
function doneCard(option: ActionOption, comments: KanbanComment[]): KanbanTask {
  const card = sampleActionItem({
    class: 'email:newsletter-unsubscribe',
    options: [option],
    ui: { primary_option_id: option.id, display_group: 'Monitored' },
  });
  return { id: 't_silent', title: card.title, status: 'done', body: JSON.stringify(card), comments };
}

function policyDecisionComment(optionId: string): KanbanComment {
  return {
    body: JSON.stringify({
      schema: 'keryx.policy_decision.v1',
      selected_option_id: optionId,
      disposition: 'silent',
      rule_id: 'r-001',
      reasons: ['active rule r-001 authorizes silent'],
      approved_by: 'keryx-policy',
      approved_via: 'policy:r-001',
      approved_at: '2026-06-26T08:00:00+10:00',
    }),
  };
}

function outcomeComment(optionId: string): KanbanComment {
  return {
    body: JSON.stringify({
      schema: 'keryx.outcome.v1',
      executed_option_id: optionId,
      result_summary: 'Unsubscribed from the newsletter.',
      result_delivery: 'digest',
      digest_category: 'Done for you',
      changed_state: 'subscription removed',
      delivered_via: null,
      completed_at: '2026-06-26T08:05:00+10:00',
    }),
  };
}

function createRunner(returnedTask: KanbanTask): ReturnType<typeof vi.fn<HermesRunner>> {
  return vi.fn<HermesRunner>(async (request) => {
    const command = request.args[3];
    if (command === 'show') {
      return { stdout: JSON.stringify({ task: returnedTask }), stderr: '', exitCode: 0 };
    }
    if (command === 'create') {
      return { stdout: JSON.stringify({ id: 't_undo', status: 'blocked' }), stderr: '', exitCode: 0 };
    }
    if (command === 'promote') {
      return { stdout: JSON.stringify({ id: 't_undo', status: 'ready' }), stderr: '', exitCode: 0 };
    }
    if (['comment', 'block', 'assign', 'archive'].includes(command)) {
      return { stdout: '', stderr: '', exitCode: 0 };
    }
    return { stdout: '', stderr: `unexpected command: ${request.args.join(' ')}`, exitCode: 1 };
  });
}

function run(task: KanbanTask, runner: ReturnType<typeof vi.fn<HermesRunner>>) {
  return runOpsctl(['undo', task.id], {
    config: loadConfig({ env: {}, configPath: null, overrides: { defaultAssignee: 'default' } }),
    hermesRunner: runner,
    now,
  });
}

describe('opsctl undo', () => {
  it('reverses a reversible option by creating a ready reversal card that runs the undo_prompt', async () => {
    const option = sampleActionOption({
      id: 'unsubscribe',
      label: 'Unsubscribe',
      reversibility: 'reversible',
      blast_radius: 'self',
      undo_prompt: 'Resubscribe to the newsletter to restore the prior state.',
      execution_prompt: 'Unsubscribe from the newsletter.',
    });
    const task = doneCard(option, [policyDecisionComment('unsubscribe'), outcomeComment('unsubscribe')]);
    const runner = createRunner(task);

    const result = await run(task, runner);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      task_id: 't_silent',
      reversibility: 'reversible',
      undo_kind: 'reverse',
      status: 'ready',
    });

    const verbs = runner.mock.calls.map((call) => call[0].args[3]);
    expect(verbs).toEqual(['show', 'create', 'comment', 'promote']);

    const createCall = runner.mock.calls.find((call) => call[0].args[3] === 'create');
    const cardBody = JSON.parse(createCall![0].args[6]);
    expect(cardBody).toMatchObject({ schema: 'keryx.action_item.v2', class: 'keryx:undo' });
    expect(cardBody.idempotency_key).toBe('keryx:undo:t_silent:unsubscribe');
    // The undo card runs the original undo_prompt as data, not as fresh instructions.
    expect(cardBody.options[0].reversibility).toBe('reversible');
    expect(cardBody.options[0].execution_prompt).toContain('Resubscribe to the newsletter');
    // The reversal is authorized by the user's explicit undo click (review-path authority).
    const decision = JSON.parse(runner.mock.calls[2][0].args[5]);
    expect(decision).toMatchObject({
      schema: 'keryx.execution_decision.v1',
      selected_option_id: cardBody.options[0].id,
      approved_by: 'User',
      approved_via: 'keryx-undo',
    });
  });

  it('issues a labeled correction (never a fake unsend) for a compensable option', async () => {
    const option = sampleActionOption({
      id: 'forward_email',
      label: 'Forward to support contact',
      reversibility: 'compensable',
      blast_radius: 'external',
      undo_prompt: 'Notify the support contact the forward was sent in error.',
      execution_prompt: 'Forward the email to the configured support contact.',
    });
    const task = doneCard(option, [outcomeComment('forward_email')]);
    const runner = createRunner(task);

    const result = await run(task, runner);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      reversibility: 'compensable',
      undo_kind: 'correct',
      status: 'ready',
    });

    const verbs = runner.mock.calls.map((call) => call[0].args[3]);
    expect(verbs).toEqual(['show', 'create', 'comment', 'promote']);

    const createCall = runner.mock.calls.find((call) => call[0].args[3] === 'create');
    const cardBody = JSON.parse(createCall![0].args[6]);
    expect(cardBody).toMatchObject({ schema: 'keryx.action_item.v2', class: 'keryx:correction' });
    expect(cardBody.idempotency_key).toBe('keryx:correct:t_silent:forward_email');
    expect(cardBody.options[0].reversibility).toBe('compensable');
    // The correction is honest: it labels a follow-up, it does not claim to unsend.
    expect(cardBody.options[0].execution_prompt).toContain('labeled correction');
    expect(cardBody.options[0].execution_prompt).toContain('Notify the support contact');
  });

  it('creates a blocked corrective/triage card for an irreversible option and never fakes an unsend', async () => {
    const option = sampleActionOption({
      id: 'submit_payment',
      label: 'Submit payment',
      reversibility: 'irreversible',
      blast_radius: 'external',
      undo_prompt: null,
      execution_prompt: 'Submit the payment through the portal.',
    });
    const task = doneCard(option, [outcomeComment('submit_payment')]);
    const runner = createRunner(task);

    const result = await run(task, runner);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      reversibility: 'irreversible',
      undo_kind: 'corrective_card',
      status: 'blocked',
    });

    // A corrective card is created blocked (create -> assign), never promoted to ready.
    const verbs = runner.mock.calls.map((call) => call[0].args[3]);
    expect(verbs).toContain('create');
    expect(verbs).toContain('assign');
    expect(verbs).not.toContain('promote');

    const createCall = runner.mock.calls.find((call) => call[0].args[3] === 'create');
    const cardBody = JSON.parse(createCall![0].args[6]);
    expect(cardBody).toMatchObject({ schema: 'keryx.action_item.v2', class: 'keryx:corrective-review' });
    expect(cardBody.idempotency_key).toBe('keryx:corrective:t_silent:submit_payment');
    // The triage option is read_only — it plans corrective steps, it does not pretend to undo.
    expect(cardBody.options[0].reversibility).toBe('read_only');
    expect(cardBody.summary.toLowerCase()).toContain('irreversible');
  });

  it('treats an absolute_floor option as non-undoable and routes it to a corrective card (floor gate)', async () => {
    const option = sampleActionOption({
      id: 'cancel_service',
      label: 'Cancel the service',
      reversibility: 'reversible',
      blast_radius: 'external',
      undo_prompt: 'Re-subscribe to the service.',
      absolute_floor: ['money'],
      execution_prompt: 'Cancel the paid service.',
    });
    const task = doneCard(option, [outcomeComment('cancel_service')]);
    const runner = createRunner(task);

    const result = await run(task, runner);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ undo_kind: 'corrective_card', status: 'blocked' });
    const verbs = runner.mock.calls.map((call) => call[0].args[3]);
    expect(verbs).not.toContain('promote');
    const createCall = runner.mock.calls.find((call) => call[0].args[3] === 'create');
    const cardBody = JSON.parse(createCall![0].args[6]);
    expect(cardBody.summary).toContain('absolute floor');
  });

  it('refuses to undo a read_only option because nothing changed', async () => {
    const option = sampleActionOption({
      id: 'summarise',
      label: 'Summarise the thread',
      reversibility: 'read_only',
      blast_radius: 'self',
      undo_prompt: null,
      execution_prompt: 'Summarise the email thread.',
    });
    const task = doneCard(option, [outcomeComment('summarise')]);
    const runner = createRunner(task);

    const result = await run(task, runner);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('read_only');
    expect(runner.mock.calls.map((call) => call[0].args[3])).toEqual(['show']);
  });

  it('fails when no executed option is recorded on the card', async () => {
    const option = sampleActionOption({ id: 'unsubscribe', reversibility: 'reversible', undo_prompt: 'Resubscribe.' });
    const task = doneCard(option, []);
    const runner = createRunner(task);

    const result = await run(task, runner);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('no executed option recorded');
  });

  it('fails when the recorded executed option is not present on the card', async () => {
    const option = sampleActionOption({ id: 'unsubscribe', reversibility: 'reversible', undo_prompt: 'Resubscribe.' });
    const task = doneCard(option, [outcomeComment('ghost_option')]);
    const runner = createRunner(task);

    const result = await run(task, runner);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('ghost_option');
  });

  it('requires a task id', async () => {
    const result = await runOpsctl(['undo'], { env: {}, configPath: null });
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('FAIL undo requires a task id');
  });

  it('rejects a task id beginning with a dash before querying Hermes', async () => {
    const option = sampleActionOption({ id: 'unsubscribe', reversibility: 'reversible', undo_prompt: 'Resubscribe.' });
    const runner = createRunner(doneCard(option, [outcomeComment('unsubscribe')]));
    const result = await runOpsctl(['undo', '-rf'], {
      config: loadConfig({ env: {}, configPath: null }),
      hermesRunner: runner,
    });
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('FAIL task id must not begin with "-"');
    expect(runner).not.toHaveBeenCalled();
  });
});
