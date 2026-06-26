import { describe, expect, it, vi } from 'vitest';

import { loadConfig } from '../../src/config';
import { runOpsctl } from '../../src/opsctl/commands';
import { sampleActionItem } from '../helpers/sampleActionItem';
import type { HermesRunner, KanbanStatus, KanbanTask } from '../../src/hermes/types';
import type { ActionItem } from '../../src/schemas/actionItem';

const actionItem: ActionItem = sampleActionItem();

const approvedAt = new Date('2026-05-31T12:34:56.000Z');

describe('opsctl execute', () => {
  it('appends an execution decision comment, promotes a blocked card, and dispatches when requested', async () => {
    const runner = createRunner(task({ id: 't_blocked', status: 'blocked' }));

    const result = await runOpsctl(
      ['execute', 't_blocked', '--option', 'translate_forward_contact_archive', '--feedback', 'Please be brief.', '--dispatch'],
      { config: loadConfig({ env: {}, configPath: null }), hermesRunner: runner, now: () => approvedAt },
    );

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      ok: true,
      task_id: 't_blocked',
      status: 'ready',
      action: 'promoted',
      selected_option_id: 'translate_forward_contact_archive',
      dispatched: true,
    });
    expect(runner).toHaveBeenNthCalledWith(1, {
      bin: 'hermes',
      args: ['kanban', '--board', 'keryx', 'show', 't_blocked', '--json'],
      env: {},
    });

    const commentRequest = runner.mock.calls[1][0];
    expect(commentRequest.args.slice(0, 5)).toEqual(['kanban', '--board', 'keryx', 'comment', 't_blocked']);
    expect(commentRequest.args).toHaveLength(6);
    expect(JSON.parse(commentRequest.args[5])).toEqual({
      schema: 'keryx.execution_decision.v1',
      selected_option_id: 'translate_forward_contact_archive',
      user_feedback: 'Please be brief.',
      approved_by: 'User',
      approved_via: 'keryx-web',
      approved_at: '2026-05-31T12:34:56.000Z',
    });
    expect(runner).toHaveBeenNthCalledWith(3, {
      bin: 'hermes',
      args: ['kanban', '--board', 'keryx', 'promote', 't_blocked', 'approved from Keryx', '--json'],
      env: {},
    });
    expect(runner).toHaveBeenNthCalledWith(4, {
      bin: 'hermes',
      args: ['kanban', '--board', 'keryx', 'dispatch', '--json'],
      env: {},
    });
  });

  it('appends an execution decision comment and promotes a todo card without dispatch by default', async () => {
    const runner = createRunner(task({ id: 't_todo', status: 'todo' }));

    const result = await runOpsctl(['execute', 't_todo', '--option', 'translate_forward_contact_archive'], {
      config: loadConfig({ env: {}, configPath: null }),
      hermesRunner: runner,
      now: () => approvedAt,
    });

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, task_id: 't_todo', action: 'promoted', dispatched: false });
    expect(runner.mock.calls.map((call) => call[0].args[3])).toEqual(['show', 'comment', 'promote']);
  });

  it.each<KanbanStatus>(['ready', 'running', 'done'])('treats %s as idempotent success without duplicate mutation', async (status) => {
    const runner = createRunner(task({ id: `t_${status}`, status }));

    const result = await runOpsctl(['execute', `t_${status}`, '--option', 'translate_forward_contact_archive'], {
      config: loadConfig({ env: {}, configPath: null }),
      hermesRunner: runner,
      now: () => approvedAt,
    });

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      ok: true,
      task_id: `t_${status}`,
      status,
      action: `already-${status}`,
      selected_option_id: 'translate_forward_contact_archive',
      dispatched: false,
    });
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it('returns a clear error for an invalid option id without mutating the card', async () => {
    const runner = createRunner(task({ id: 't_bad_option', status: 'blocked' }));

    const result = await runOpsctl(['execute', 't_bad_option', '--option', 'missing_option'], {
      config: loadConfig({ env: {}, configPath: null }),
      hermesRunner: runner,
      now: () => approvedAt,
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('FAIL invalid option ID missing_option for t_bad_option');
    expect(result.stderr).toContain('translate_forward_contact_archive');
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it('returns a clear error for a malformed action-item body without mutating the card', async () => {
    const runner = createRunner({ id: 't_malformed', status: 'blocked', body: '{not json' });

    const result = await runOpsctl(['execute', 't_malformed', '--option', 'translate_forward_contact_archive'], {
      config: loadConfig({ env: {}, configPath: null }),
      hermesRunner: runner,
      now: () => approvedAt,
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('FAIL invalid action body for t_malformed');
    expect(result.stderr).toContain('not valid JSON');
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it('rejects a task id beginning with a dash with exit code 2 before querying Hermes', async () => {
    const runner = createRunner(task({ id: 't_blocked', status: 'blocked' }));

    const result = await runOpsctl(['execute', '-rf', '--option', 'translate_forward_contact_archive'], {
      config: loadConfig({ env: {}, configPath: null }),
      hermesRunner: runner,
      now: () => approvedAt,
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
    if (['promote', 'dispatch'].includes(command)) {
      return { stdout: JSON.stringify({ ok: true }), stderr: '', exitCode: 0 };
    }
    return { stdout: '', stderr: `unexpected command: ${request.args.join(' ')}`, exitCode: 1 };
  });
}
