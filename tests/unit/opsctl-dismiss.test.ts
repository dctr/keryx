import { describe, expect, it, vi } from 'vitest';

import { loadConfig } from '../../src/config';
import { runOpsctl } from '../../src/opsctl/commands';
import type { HermesRunner, KanbanStatus, KanbanTask } from '../../src/hermes/types';
import type { ActionItem } from '../../src/schemas/actionItem';

const actionItem: ActionItem = {
  schema: 'keryx.action_item.v1',
  source: 'email',
  collector: 'keryx-email',
  external_id: 'support-inbox:INBOX:35680',
  idempotency_key: 'keryx:email:support-inbox:INBOX:35680',
  origin_descriptor: 'Support Desk — Account access request',
  title: 'Support request: account access needs review',
  summary: 'Customer reports that account access is failing after a recent change.',
  autonomy: 'auto',
  urgency: 'normal',
  deadline: null,
  risk: 'Support request may stall if ignored.',
  source_refs: [{ type: 'email', account: 'support-inbox', folder: 'INBOX', uid: '35680' }],
  options: [
    {
      id: 'translate_forward_contact_archive',
      label: 'Translate + forward to support contact + archive email',
      requires_input: false,
      input_hint: null,
      delivery: null,
      execution_prompt:
        "Translate the support request into the target language, forward it to the configured support contact, then archive the source email.",
    },
  ],
  ui: { primary_option_id: 'translate_forward_contact_archive', display_group: 'Needs approval' },
  created_at: '2026-05-31T00:00:00+10:00',
};

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

    const commentRequest = runner.mock.calls[1][0];
    expect(commentRequest.args.slice(0, 5)).toEqual(['kanban', '--board', 'keryx', 'comment', 't_dismiss']);
    expect(commentRequest.args).toHaveLength(6);
    expect(JSON.parse(commentRequest.args[5])).toEqual({
      schema: 'keryx.dismissal_decision.v1',
      dismissal_scope: 'exact_item',
      reason: 'No longer relevant',
      dismissed_external_id: 'support-inbox:INBOX:35680',
      dismissed_idempotency_key: 'keryx:email:support-inbox:INBOX:35680',
      dismissed_by: 'User',
      dismissed_via: 'keryx-web',
      dismissed_at: '2026-05-31T12:34:56.000Z',
    });
    expect(runner).toHaveBeenNthCalledWith(3, {
      bin: 'hermes',
      args: ['kanban', '--board', 'keryx', 'archive', 't_dismiss'],
      env: {},
    });
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
