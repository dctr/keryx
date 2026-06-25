import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { loadConfig } from '../../src/config';
import { createFakeHermes } from '../../src/hermes/fakeHermes';
import type { HermesRunner, KanbanTask } from '../../src/hermes/types';
import { createServer } from '../../src/server/app';
import { sampleActionItem } from '../helpers/sampleActionItem';
import type { ActionItem } from '../../src/schemas/actionItem';

const actionItem: ActionItem = sampleActionItem();

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

  it('records an escalation-regret signal through opsctl', async () => {
    const fakeHermes = createFakeHermes({ tasks: [task({ id: 't_silent', status: 'done', body: JSON.stringify(actionItem) })] });
    const server = createServer({
      config: loadConfig({ env: {}, configPath: null }),
      hermesRunner: fakeHermes.runner,
      now: () => new Date('2026-05-31T12:34:56.000Z'),
    });

    try {
      const response = await server.inject({
        method: 'POST',
        url: '/api/tasks/t_silent/regret',
        payload: { kind: 'should_have_asked', note: 'Too aggressive.' },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ ok: true, task_id: 't_silent', kind: 'should_have_asked' });
      const commentRequest = fakeHermes.requests.find((request) => request.args[3] === 'comment');
      expect(commentRequest).toBeDefined();
      expect(JSON.parse(commentRequest!.args[5])).toMatchObject({
        schema: 'keryx.regret.v1',
        kind: 'should_have_asked',
        note: 'Too aggressive.',
      });
    } finally {
      await server.close();
    }
  });

  it('serves a collector policy and derives bands from the audit trail', async () => {
    const home = homeWithPolicy();
    try {
      const fakeHermes = createFakeHermes({ tasks: [] });
      const server = createServer({
        config: loadConfig({ env: {}, configPath: null, overrides: { hermesHome: home } }),
        hermesRunner: fakeHermes.runner,
      });

      try {
        const response = await server.inject({ method: 'GET', url: '/api/policy/keryx-email' });

        expect(response.statusCode).toBe(200);
        expect(response.headers['cache-control']).toBe('no-store');
        const payload = response.json() as { collector: string; exists: boolean; rules: Array<{ id: string; state: string }> };
        expect(payload.collector).toBe('keryx-email');
        expect(payload.exists).toBe(true);
        expect(payload.rules.map((rule) => rule.id)).toEqual(['r-001']);
      } finally {
        await server.close();
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('proposes a policy revocation card through opsctl', async () => {
    const home = homeWithPolicy();
    try {
      const fakeHermes = createFakeHermes({ tasks: [] });
      const server = createServer({
        config: loadConfig({ env: {}, configPath: null, overrides: { hermesHome: home } }),
        hermesRunner: fakeHermes.runner,
        now: () => new Date('2026-05-31T12:34:56.000Z'),
      });

      try {
        const response = await server.inject({ method: 'POST', url: '/api/policy/keryx-email/revoke', payload: { rule_id: 'r-001' } });

        expect(response.statusCode).toBe(200);
        const createRequest = fakeHermes.requests.find((request) => request.args[3] === 'create');
        expect(createRequest).toBeDefined();
        const body = JSON.parse(createRequest!.args[6]);
        expect(body).toMatchObject({ schema: 'keryx.action_item.v2', class: 'policy:rule-revocation' });
        expect(body.idempotency_key).toBe('keryx:policy-revocation:keryx-email:r-001');
      } finally {
        await server.close();
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('serves attention-economics metrics derived from Kanban tasks', async () => {
    const fakeHermes = createFakeHermes({
      tasks: [task({ id: 't_metric', status: 'blocked', body: JSON.stringify(actionItem) })],
    });
    const server = createServer({ config: loadConfig({ env: {}, configPath: null }), hermesRunner: fakeHermes.runner });

    try {
      const response = await server.inject({ method: 'GET', url: '/api/metrics' });

      expect(response.statusCode).toBe(200);
      expect(response.headers['cache-control']).toBe('no-store');
      const payload = response.json() as { counts: { tasks: number } };
      expect(payload.counts.tasks).toBe(1);
    } finally {
      await server.close();
    }
  });
});

const policyDocument = {
  schema: 'keryx.policy.v1',
  collector: 'keryx-email',
  version: 2,
  updated_at: '2026-06-25T09:00:00Z',
  rules: [
    {
      id: 'r-001',
      class: 'email:newsletter-unsubscribe',
      gate: { max_blast_radius: 'self', min_reversibility: 'reversible', min_confidence: 'trusted' },
      disposition: 'silent',
      result_delivery: 'digest',
      state: 'active',
      approved_by: 'User',
      approved_at: '2026-06-25T09:00:00Z',
      source_card_id: 'keryx-123',
      scope_note: 'auto-handle one-click unsubscribes from known senders',
    },
  ],
  thresholds: { spend_requires_approval_always: true },
  track_record: {},
};

function homeWithPolicy(): string {
  const home = mkdtempSync(join(tmpdir(), 'keryx-server-policy-'));
  const dir = join(home, 'skills', 'keryx-collector-email', 'references');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'policy.json'), JSON.stringify(policyDocument), 'utf8');
  return home;
}

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
