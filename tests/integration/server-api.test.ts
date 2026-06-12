import { describe, expect, it, vi } from 'vitest';

import { loadConfig } from '../../src/config';
import { createFakeHermes } from '../../src/hermes/fakeHermes';
import type { HermesRunner, KanbanTask } from '../../src/hermes/types';
import { createServer } from '../../src/server/app';
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

describe('server API with fake Hermes', () => {
  it('returns parsed task cards and malformed-card errors without mutating Kanban', async () => {
    const fakeHermes = createFakeHermes({
      tasks: [
        task({ id: 't_good', title: 'Good action', status: 'blocked', body: JSON.stringify(actionItem) }),
        task({ id: 't_bad', title: 'Bad action', status: 'blocked', body: '{not json' }),
      ],
    });
    const server = createServer({ config: loadConfig({ env: {}, configPath: null }), hermesRunner: fakeHermes.runner });

    try {
      const response = await server.inject({ method: 'GET', url: '/api/tasks' });

      expect(response.statusCode).toBe(200);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.json()).toEqual({
        ok: true,
        tasks: [
          {
            id: 't_good',
            title: 'Good action',
            status: 'blocked',
            source: 'email',
            tenant: 'email',
            created_by: 'keryx-email',
            action_item: actionItem,
          },
        ],
        errors: [
          {
            task_id: 't_bad',
            title: 'Bad action',
            status: 'blocked',
            error: expect.stringContaining('task body is not valid JSON'),
          },
        ],
      });
      expect(fakeHermes.requests.map((request) => request.args)).toEqual([['kanban', '--board', 'keryx', 'list', '--json']]);
    } finally {
      await server.close();
    }
  });

  it('keeps a primary_option_id-mismatch card visible as a malformed-card error', async () => {
    const mismatched = { ...actionItem, ui: { primary_option_id: 'ghost_option', display_group: 'Needs approval' } };
    const fakeHermes = createFakeHermes({
      tasks: [
        task({ id: 't_good', title: 'Good action', status: 'blocked', body: JSON.stringify(actionItem) }),
        task({ id: 't_mismatch', title: 'Mismatched primary option', status: 'blocked', body: JSON.stringify(mismatched) }),
      ],
    });
    const server = createServer({ config: loadConfig({ env: {}, configPath: null }), hermesRunner: fakeHermes.runner });

    try {
      const response = await server.inject({ method: 'GET', url: '/api/tasks' });

      expect(response.statusCode).toBe(200);
      const payload = response.json() as { ok: boolean; tasks: Array<{ id: string }>; errors: Array<{ task_id: string; error: string }> };
      expect(payload.tasks.map((entry) => entry.id)).toEqual(['t_good']);
      expect(payload.errors).toEqual([
        expect.objectContaining({ task_id: 't_mismatch', error: expect.stringContaining('/ui/primary_option_id') }),
      ]);
    } finally {
      await server.close();
    }
  });

  it('returns keryx source health from Hermes cron status', async () => {
    const runner = vi.fn<HermesRunner>(async (request) => {
      if (request.args.join(' ') === 'cron list --all') {
        return {
          stdout: `
  job_email [active]
    Name:      keryx-email
    Schedule:  every 10m
    Next run:  2026-05-31T12:10:00.000Z
    Last run:  2026-05-31T12:00:00.000Z  ok

  job_calendar [disabled]
    Name:      keryx-calendar
    Schedule:  every 1h
    Last run:  2026-05-31T12:00:00.000Z  ok

  job_events [active]
    Name:      keryx-events
    Schedule:  every 2h
    Last run:  2026-05-31T12:00:00.000Z  error

  job_other [active]
    Name:      daily-brief
`,
          stderr: '',
          exitCode: 0,
        };
      }
      return { stdout: '', stderr: `unexpected command: ${request.args.join(' ')}`, exitCode: 1 };
    });
    const server = createServer({ config: loadConfig({ env: {}, configPath: null }), hermesRunner: runner });

    try {
      const response = await server.inject({ method: 'GET', url: '/api/sources' });

      expect(response.statusCode).toBe(200);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.json()).toEqual({
        ok: true,
        sources: [
          {
            id: 'job_email',
            name: 'keryx-email',
            source: 'email',
            state: 'active',
            status: 'OK',
            enabled: true,
            schedule: 'every 10m',
            last_status: 'ok',
            last_run_at: '2026-05-31T12:00:00.000Z',
            next_run_at: '2026-05-31T12:10:00.000Z',
          },
          {
            id: 'job_calendar',
            name: 'keryx-calendar',
            source: 'calendar',
            state: 'disabled',
            status: 'PAUSED',
            enabled: false,
            schedule: 'every 1h',
            last_status: 'ok',
            last_run_at: '2026-05-31T12:00:00.000Z',
          },
          {
            id: 'job_events',
            name: 'keryx-events',
            source: 'events',
            state: 'active',
            status: 'FAILED',
            enabled: true,
            schedule: 'every 2h',
            last_status: 'error',
            last_run_at: '2026-05-31T12:00:00.000Z',
          },
        ],
      });
      expect(runner).toHaveBeenCalledWith({ bin: 'hermes', args: ['cron', 'list', '--all'], env: {} });
    } finally {
      await server.close();
    }
  });

  it('executes a task through opsctl using the fake Hermes adapter', async () => {
    const fakeHermes = createFakeHermes({ tasks: [task({ id: 't_execute', status: 'blocked', body: JSON.stringify(actionItem) })] });
    const server = createServer({
      config: loadConfig({ env: {}, configPath: null }),
      hermesRunner: fakeHermes.runner,
      now: () => new Date('2026-05-31T12:34:56.000Z'),
    });

    try {
      const response = await server.inject({
        method: 'POST',
        url: '/api/tasks/t_execute/execute',
        payload: { option_id: 'translate_forward_contact_archive', feedback: 'Please be brief.' },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ ok: true, task_id: 't_execute', status: 'ready', action: 'promoted' });
      expect(fakeHermes.requests.map((request) => request.args[3])).toEqual(['show', 'comment', 'promote']);
      const commentArgs = fakeHermes.requests[1].args;
      expect(JSON.parse(commentArgs[5])).toMatchObject({
        schema: 'keryx.execution_decision.v1',
        selected_option_id: 'translate_forward_contact_archive',
        user_feedback: 'Please be brief.',
      });
    } finally {
      await server.close();
    }
  });

  it('returns concise API errors when opsctl rejects an invalid selected option', async () => {
    const fakeHermes = createFakeHermes({ tasks: [task({ id: 't_execute', status: 'blocked', body: JSON.stringify(actionItem) })] });
    const server = createServer({ config: loadConfig({ env: {}, configPath: null }), hermesRunner: fakeHermes.runner });

    try {
      const response = await server.inject({
        method: 'POST',
        url: '/api/tasks/t_execute/execute',
        payload: { option_id: 'missing_option' },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({
        ok: false,
        error: {
          code: 'OPSCTL_ERROR',
          message: expect.stringContaining('invalid option ID missing_option'),
        },
      });
      expect(fakeHermes.requests).toHaveLength(1);
    } finally {
      await server.close();
    }
  });

  it('dismisses a task through opsctl using the fake Hermes adapter', async () => {
    const fakeHermes = createFakeHermes({ tasks: [task({ id: 't_dismiss', status: 'blocked', body: JSON.stringify(actionItem) })] });
    const server = createServer({
      config: loadConfig({ env: {}, configPath: null }),
      hermesRunner: fakeHermes.runner,
      now: () => new Date('2026-05-31T12:34:56.000Z'),
    });

    try {
      const response = await server.inject({ method: 'POST', url: '/api/tasks/t_dismiss/dismiss', payload: { reason: 'Not needed.' } });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ ok: true, task_id: 't_dismiss', status: 'archived', action: 'archived' });
      expect(fakeHermes.requests.map((request) => request.args[3])).toEqual(['show', 'comment', 'archive']);
      expect(JSON.parse(fakeHermes.requests[1].args[5])).toMatchObject({
        schema: 'keryx.dismissal_decision.v1',
        dismissal_scope: 'exact_item',
        reason: 'Not needed.',
      });
    } finally {
      await server.close();
    }
  });
});

function task(overrides: Partial<KanbanTask>): KanbanTask {
  return {
    id: 't_default',
    title: 'Keryx action',
    status: 'blocked',
    tenant: 'email',
    created_by: 'keryx-email',
    body: JSON.stringify(actionItem),
    ...overrides,
  };
}
