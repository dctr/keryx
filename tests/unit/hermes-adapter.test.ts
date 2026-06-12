import { describe, expect, it, vi } from 'vitest';

import { loadConfig } from '../../src/config';
import {
  HermesCliAdapter,
  assertAllowedHermesArgs,
  parseDeliveryTargets,
  parseCronListText,
  parseKanbanTask,
  parseKanbanTasks,
} from '../../src/hermes/adapter';
import type { HermesRunner } from '../../src/hermes/types';

describe('Hermes CLI adapter', () => {
  it('constructs allowlisted Kanban list commands with injected runner and isolated HERMES_HOME', async () => {
    const runner = vi.fn<HermesRunner>(async () => ({
      stdout: JSON.stringify([{ id: 't_1', title: 'One', status: 'blocked', body: '{}' }]),
      stderr: '',
      exitCode: 0,
    }));
    const adapter = new HermesCliAdapter(
      loadConfig({
        env: { HERMES_HOME: '/tmp/keryx-test-home' },
        configPath: null,
        overrides: { board: 'keryx-test', hermesBin: '/tmp/fake-hermes' },
      }),
      runner,
    );

    const tasks = await adapter.listTasks({ status: 'blocked', source: 'email' });

    expect(tasks).toEqual([{ id: 't_1', title: 'One', status: 'blocked', body: '{}' }]);
    expect(runner).toHaveBeenCalledWith({
      bin: '/tmp/fake-hermes',
      args: ['kanban', '--board', 'keryx-test', 'list', '--status', 'blocked', '--tenant', 'email', '--json'],
      env: expect.objectContaining({ HERMES_HOME: '/tmp/keryx-test-home' }),
    });
  });

  it('constructs show and delivery-target commands without touching the real Hermes CLI', async () => {
    const runner = vi.fn<HermesRunner>(async () => ({ stdout: '{}', stderr: '', exitCode: 0 }))
      .mockResolvedValueOnce({
        stdout: JSON.stringify({ task: { id: 't_abc', title: 'Show me', status: 'blocked', body: '{}' } }),
        stderr: '',
        exitCode: 0,
      })
      .mockResolvedValueOnce({
        stdout: JSON.stringify({ platforms: { discord: [{ id: '#ops', name: 'Discord ops', type: 'channel' }] } }),
        stderr: '',
        exitCode: 0,
      });
    const adapter = new HermesCliAdapter(loadConfig({ env: {}, configPath: null }), runner);

    await expect(adapter.showTask('t_abc')).resolves.toMatchObject({ id: 't_abc', title: 'Show me' });
    await expect(adapter.listDeliveryTargets()).resolves.toEqual([
      { target: 'discord', label: 'discord home', platform: 'discord' },
      { target: 'discord:#ops', label: 'Discord ops', platform: 'discord' },
    ]);

    expect(runner.mock.calls).toHaveLength(2);
    const firstRequest = runner.mock.calls.at(0)?.[0];
    const secondRequest = runner.mock.calls.at(1)?.[0];
    expect(firstRequest?.args).toEqual(['kanban', '--board', 'keryx', 'show', 't_abc', '--json']);
    expect(secondRequest?.args).toEqual(['send', '--list', '--json']);
  });

  it('allowlists only the central Keryx Kanban create-card shape', () => {
    const allowedCreateArgs = [
      'kanban',
      '--board',
      'keryx',
      'create',
      'Support request: account access needs review',
      '--body',
      '{"schema":"keryx.action_item.v1"}',
      '--assignee',
      'default',
      '--tenant',
      'email',
      '--idempotency-key',
      'keryx:email:support-inbox:INBOX:35680',
      '--created-by',
      'keryx-email',
      '--skill',
      'keryx:keryx-worker',
      '--initial-status',
      'blocked',
      '--json',
    ];

    expect(() => assertAllowedHermesArgs(allowedCreateArgs)).not.toThrow();
    expect(() => assertAllowedHermesArgs(replaceArg(allowedCreateArgs, 16, 'keryx-worker'))).toThrow(/not allowlisted/i);
    expect(() => assertAllowedHermesArgs(replaceArg(allowedCreateArgs, 18, 'ready'))).toThrow(/not allowlisted/i);
    expect(() => assertAllowedHermesArgs([...allowedCreateArgs.slice(0, -1), '--priority', '10', '--json'])).toThrow(
      /not allowlisted/i,
    );
  });

  it('rejects non-allowlisted Hermes command shapes', () => {
    expect(() => assertAllowedHermesArgs(['config', 'path'])).toThrow(/not allowlisted/i);
    expect(() => assertAllowedHermesArgs(['kanban', '--board', 'keryx', 'delete', 't_1', '--json'])).toThrow(
      /not allowlisted/i,
    );
    expect(() => assertAllowedHermesArgs(['kanban', '--board', 'keryx', 'show', 't_1', '--json'])).not.toThrow();
  });

  it('parses Hermes Kanban JSON envelopes', () => {
    expect(parseKanbanTasks(JSON.stringify([{ id: 't_2', status: 'done' }]))).toEqual([{ id: 't_2', status: 'done' }]);
    expect(parseKanbanTask(JSON.stringify({ task: { id: 't_3', title: 'Single' } }))).toEqual({ id: 't_3', title: 'Single' });
    expect(() => parseKanbanTasks(JSON.stringify({ tasks: [{ id: 't_1', status: 'blocked' }] }))).toThrow(
      /Hermes Kanban list JSON did not contain a task array/,
    );
  });

  it('normalises Hermes send list JSON into delivery targets', () => {
    expect(
      parseDeliveryTargets(
        JSON.stringify({
          platforms: {
            telegram: [{ id: '293041098', name: 'David', type: 'dm', thread_id: null }],
            discord: [],
          },
        }),
      ),
    ).toEqual([
      { target: 'telegram', label: 'telegram home', platform: 'telegram' },
      { target: 'telegram:293041098', label: 'David', platform: 'telegram' },
    ]);
    expect(parseDeliveryTargets(JSON.stringify({ targets: [{ target: 'telegram' }] }))).toEqual([]);
  });

  it('parses current Hermes cron list text output into cron job records', () => {
    expect(
      parseCronListText(`
  12da39e0873d [active]
    Name:      Daily Brief
    Schedule:  0 7 * * *
    Repeat:    ∞
    Next run:  2026-06-02T07:00:00+10:00
    Deliver:   discord
    Last run:  2026-06-01T07:06:14.385780+10:00  ok

  abcd1234 [disabled]
    Name:      keryx-email
    Schedule:  every 10m
    Repeat:    ∞
    Next run:  —
    Last run:  2026-06-01T09:00:00+10:00  error
`),
    ).toEqual([
      {
        id: '12da39e0873d',
        name: 'Daily Brief',
        enabled: true,
        state: 'active',
        schedule: '0 7 * * *',
        next_run_at: '2026-06-02T07:00:00+10:00',
        last_run_at: '2026-06-01T07:06:14.385780+10:00',
        last_status: 'ok',
      },
      {
        id: 'abcd1234',
        name: 'keryx-email',
        enabled: false,
        state: 'disabled',
        schedule: 'every 10m',
        next_run_at: '—',
        last_run_at: '2026-06-01T09:00:00+10:00',
        last_status: 'error',
      },
    ]);
  });
});

function replaceArg(args: string[], index: number, value: string): string[] {
  const copy = [...args];
  copy[index] = value;
  return copy;
}
