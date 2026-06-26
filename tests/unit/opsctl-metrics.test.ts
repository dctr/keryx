import { describe, expect, it, vi } from 'vitest';

import { runOpsctl } from '../../src/opsctl/commands';
import { sampleActionItem } from '../helpers/sampleActionItem';
import type { HermesRunner, KanbanComment, KanbanTask } from '../../src/hermes/types';

function card(): string {
  return JSON.stringify(
    sampleActionItem({
      class: 'email:newsletter-unsubscribe',
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
      ],
      ui: { primary_option_id: 'unsubscribe', display_group: 'Monitored' },
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

function task(id: string, status: string, comments: KanbanComment[]): KanbanTask {
  return { id, status, body: card(), comments };
}

// Models the live two-call contract: `list --json` omits per-task comments; only
// `show --json` embeds them. A comment-reading command must enrich via show.
function listRunner(tasks: KanbanTask[]): HermesRunner {
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
    return { stdout: '[]', stderr: '', exitCode: 0 };
  });
}

describe('opsctl metrics', () => {
  it('renders a metrics summary derived from Kanban', async () => {
    const tasks = [
      task('t1', 'done', [silentDecision(), outcome()]),
      task('t2', 'done', [silentDecision(), outcome()]),
    ];
    const result = await runOpsctl(['metrics'], {
      env: {},
      configPath: null,
      hermesRunner: listRunner(tasks),
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('keryx metrics');
    expect(result.stdout).toContain('silent executions: 2');
    expect(result.stdout).toContain('tasks: 2');
  });

  it('emits machine-readable JSON with --json', async () => {
    const tasks = [task('t1', 'done', [silentDecision(), outcome()])];
    const result = await runOpsctl(['metrics', '--json'], {
      env: {},
      configPath: null,
      hermesRunner: listRunner(tasks),
    });

    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout) as { counts: { silentExecutions: number; tasks: number } };
    expect(parsed.counts.silentExecutions).toBe(1);
    expect(parsed.counts.tasks).toBe(1);
  });

  it('honors a relative --window, ignoring comments outside it', async () => {
    const tasks = [
      task('t1', 'done', [silentDecision('2026-06-01T00:00:00+10:00')]),
      task('t2', 'done', [silentDecision('2026-06-25T00:00:00+10:00')]),
    ];
    const result = await runOpsctl(['metrics', '--window', '7d', '--json'], {
      env: {},
      configPath: null,
      hermesRunner: listRunner(tasks),
      now: () => new Date('2026-06-26T00:00:00+10:00'),
    });

    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout) as { counts: { silentExecutions: number } };
    expect(parsed.counts.silentExecutions).toBe(1);
  });

  it('rejects an unparseable --window', async () => {
    const result = await runOpsctl(['metrics', '--window', 'nonsense'], {
      env: {},
      configPath: null,
      hermesRunner: listRunner([]),
    });
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('FAIL metrics --window');
  });
});
