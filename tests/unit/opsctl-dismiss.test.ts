import { describe, expect, it, vi } from 'vitest';

import { loadConfig } from '../../src/config';
import { runOpsctl } from '../../src/opsctl/commands';
import { sampleActionItem } from '../helpers/sampleActionItem';
import type { HermesRunner, KanbanStatus, KanbanTask } from '../../src/hermes/types';
import type { ActionItem } from '../../src/schemas/actionItem';

const actionItem: ActionItem = sampleActionItem();

const dismissedAt = new Date('2026-05-31T12:34:56.000Z');

describe('opsctl dismiss', () => {
  it('appends an exact-item dismissal comment and archives the card', async () => {
    const runner = createRunner(task({ id: 't_dismiss', status: 'blocked' }));

    const result = await runOpsctl(['dismiss', 't_dismiss', '--reason', 'No longer relevant'], {
      config: loadConfig({ env: {}, configPath: null }),
      hermesRunner: runner,
      now: () => dismissedAt,
    });

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      ok: true,
      task_id: 't_dismiss',
      status: 'archived',
      action: 'archived',
      dismissal_scope: 'exact_item',
      external_id: 'support-inbox:INBOX:35680',
      idempotency_key: 'keryx:email:support-inbox:INBOX:35680',
    });
    expect(runner).toHaveBeenNthCalledWith(1, {
      bin: 'hermes',
      args: ['kanban', '--board', 'keryx', 'show', 't_dismiss', '--json'],
      env: {},
    });

    const decisionCommentRequest = runner.mock.calls[1][0];
    expect(decisionCommentRequest.args.slice(0, 5)).toEqual(['kanban', '--board', 'keryx', 'comment', 't_dismiss']);
    expect(decisionCommentRequest.args).toHaveLength(6);
    expect(JSON.parse(decisionCommentRequest.args[5])).toEqual({
      schema: 'keryx.dismissal_decision.v1',
      dismissal_scope: 'exact_item',
      reason: 'No longer relevant',
      dismissed_external_id: 'support-inbox:INBOX:35680',
      dismissed_idempotency_key: 'keryx:email:support-inbox:INBOX:35680',
      dismissed_by: 'User',
      dismissed_via: 'keryx-web',
      dismissed_at: '2026-05-31T12:34:56.000Z',
    });

    const correctionCommentRequest = runner.mock.calls[2][0];
    expect(correctionCommentRequest.args.slice(0, 5)).toEqual(['kanban', '--board', 'keryx', 'comment', 't_dismiss']);
    expect(correctionCommentRequest.args).toHaveLength(6);
    expect(JSON.parse(correctionCommentRequest.args[5])).toEqual({
      schema: 'keryx.correction.v1',
      collector: 'keryx-email',
      class: 'email:support-request',
      external_id: 'support-inbox:INBOX:35680',
      idempotency_key: 'keryx:email:support-inbox:INBOX:35680',
      kind: 'rejection_feedback',
      note: 'No longer relevant',
      recorded_by: 'User',
      recorded_via: 'keryx-web',
      recorded_at: '2026-05-31T12:34:56.000Z',
    });
    expect(runner).toHaveBeenNthCalledWith(4, {
      bin: 'hermes',
      args: ['kanban', '--board', 'keryx', 'archive', 't_dismiss'],
      env: {},
    });
  });

  it('does not append a correction comment when reason is omitted', async () => {
    const runner = createRunner(task({ id: 't_dismiss', status: 'blocked' }));

    const result = await runOpsctl(['dismiss', 't_dismiss'], {
      config: loadConfig({ env: {}, configPath: null }),
      hermesRunner: runner,
      now: () => dismissedAt,
    });

    expect(result.exitCode).toBe(0);
    expect(runner.mock.calls.map((call) => call[0].args[3])).toEqual(['show', 'comment', 'archive']);
    expect(JSON.parse(runner.mock.calls[1][0].args[5])).toMatchObject({ schema: 'keryx.dismissal_decision.v1', reason: null });
  });

  it.each<[KanbanStatus, string]>([
    ['archived', 'already-archived'],
    ['done', 'already-done'],
  ])('treats %s as an explicit no-op', async (status, action) => {
    const runner = createRunner(task({ id: `t_${status}`, status }));

    const result = await runOpsctl(['dismiss', `t_${status}`, '--reason', 'No longer relevant'], {
      config: loadConfig({ env: {}, configPath: null }),
      hermesRunner: runner,
      now: () => dismissedAt,
    });

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      ok: true,
      task_id: `t_${status}`,
      status,
      action,
      dismissal_scope: 'exact_item',
      external_id: 'support-inbox:INBOX:35680',
      idempotency_key: 'keryx:email:support-inbox:INBOX:35680',
    });
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it('returns a clear error for malformed action-item body without archiving the card', async () => {
    const runner = createRunner({ id: 't_malformed', status: 'blocked', body: '{not json' });

    const result = await runOpsctl(['dismiss', 't_malformed', '--reason', 'No longer relevant'], {
      config: loadConfig({ env: {}, configPath: null }),
      hermesRunner: runner,
      now: () => dismissedAt,
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('FAIL invalid action body for t_malformed');
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it('rejects a task id beginning with a dash with exit code 2 before querying Hermes', async () => {
    const runner = createRunner(task({ id: 't_dismiss', status: 'blocked' }));

    const result = await runOpsctl(['dismiss', '-rf', '--reason', 'No longer relevant'], {
      config: loadConfig({ env: {}, configPath: null }),
      hermesRunner: runner,
      now: () => dismissedAt,
    });

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('FAIL task id must not begin with "-"');
    expect(runner).not.toHaveBeenCalled();
  });
});

function task(overrides: Partial<KanbanTask>): KanbanTask {
  return { id: 't_default', title: 'Keryx action', status: 'blocked', body: JSON.stringify(actionItem), ...overrides };
}

function createRunner(returnedTask: KanbanTask) {
  return vi.fn<HermesRunner>(async (request) => {
    const command = request.args[3];
    if (command === 'show') {
      return { stdout: JSON.stringify({ task: returnedTask }), stderr: '', exitCode: 0 };
    }
    if (command === 'comment') {
      return { stdout: 'Comment added.\n', stderr: '', exitCode: 0 };
    }
    if (command === 'archive') {
      return { stdout: 'Archived 1 task.\n', stderr: '', exitCode: 0 };
    }
    return { stdout: '', stderr: `unexpected command: ${request.args.join(' ')}`, exitCode: 1 };
  });
}
