import { describe, expect, it, vi } from 'vitest';

import { loadConfig } from '../../src/config';
import { composeDigest, extractOutcomes, type DigestOutcome } from '../../src/opsctl/digest';
import { runOpsctl } from '../../src/opsctl/commands';
import type { HermesRunner, KanbanTask } from '../../src/hermes/types';

function outcome(overrides: Partial<DigestOutcome> = {}): DigestOutcome {
  return {
    digest_category: 'Facebook',
    result_summary: 'Summarised a new post.',
    result_delivery: 'digest',
    changed_state: null,
    ...overrides,
  };
}

describe('digest composer', () => {
  it('groups outcomes by category, ordered by relevancy then alphabetically, with one-liners', () => {
    const result = composeDigest(
      [
        outcome({ digest_category: '🧹 Done For You', result_summary: 'Unsubscribed from Acme Weekly.' }),
        outcome({ digest_category: '📰 Facebook', result_summary: 'New post in Local Makers.' }),
        outcome({ digest_category: '📰 Facebook', result_summary: 'New post in Trail Runners.' }),
        outcome({ digest_category: '🏷 Sales & Events', result_summary: 'Boots 20% off until Friday.' }),
      ],
      { cadence: 'daily', categoryOrder: ['📰 Facebook', '🏷 Sales & Events'] },
    );

    expect(result.silent).toBe(false);
    expect(result.categories.map((category) => category.category)).toEqual([
      '📰 Facebook',
      '🏷 Sales & Events',
      '🧹 Done For You',
    ]);
    expect(result.message).toBe(
      [
        '📰 FACEBOOK',
        '• New post in Local Makers.',
        '• New post in Trail Runners.',
        '',
        '🏷 SALES & EVENTS',
        '• Boots 20% off until Friday.',
        '',
        '🧹 DONE FOR YOU',
        '• Unsubscribed from Acme Weekly.',
      ].join('\n'),
    );
  });

  it('omits empty categories and only reports digest-delivery outcomes', () => {
    const result = composeDigest(
      [
        outcome({ digest_category: 'Facebook', result_summary: 'Reported in digest.' }),
        outcome({ digest_category: 'Push lane', result_summary: 'Pushed elsewhere.', result_delivery: 'push' }),
        outcome({ digest_category: 'Log lane', result_summary: 'Logged only.', result_delivery: 'log_only' }),
      ],
      { cadence: 'daily' },
    );

    expect(result.categories.map((category) => category.category)).toEqual(['Facebook']);
    expect(result.message).not.toContain('Push lane');
    expect(result.message).not.toContain('Log lane');
  });

  it('returns [SILENT] when there is nothing to report', () => {
    const result = composeDigest([], { cadence: 'daily' });

    expect(result.silent).toBe(true);
    expect(result.message).toBe('[SILENT]');
    expect(result.categories).toEqual([]);
  });

  it('filters by cadence, treating a missing cadence as daily', () => {
    const outcomes = [
      outcome({ digest_category: 'Daily default', result_summary: 'No cadence set.' }),
      outcome({ digest_category: 'Daily explicit', result_summary: 'Daily.', digest_cadence: 'daily' }),
      outcome({ digest_category: 'Weekly', result_summary: 'Weekly.', digest_cadence: 'weekly' }),
    ];

    const daily = composeDigest(outcomes, { cadence: 'daily' });
    expect(daily.categories.map((category) => category.category).sort()).toEqual(['Daily default', 'Daily explicit']);

    const weekly = composeDigest(outcomes, { cadence: 'weekly' });
    expect(weekly.categories.map((category) => category.category)).toEqual(['Weekly']);
  });

  it('skips outcomes already marked digested (once-only)', () => {
    const result = composeDigest(
      [
        outcome({ digest_category: 'Fresh', result_summary: 'New outcome.' }),
        outcome({ digest_category: 'Old', result_summary: 'Already reported.', digested: true }),
      ],
      { cadence: 'daily' },
    );

    expect(result.categories.map((category) => category.category)).toEqual(['Fresh']);
  });

  it('falls back to a default category when digest_category is null', () => {
    const result = composeDigest([outcome({ digest_category: null, result_summary: 'Uncategorised.' })], {
      cadence: 'daily',
      defaultCategory: 'Done for you',
    });

    expect(result.categories.map((category) => category.category)).toEqual(['Done for you']);
  });
});

describe('extractOutcomes', () => {
  it('collects valid keryx.outcome.v1 comment bodies from tasks, skipping non-outcome comments', () => {
    const tasks: KanbanTask[] = [
      {
        id: 't_1',
        comments: [
          { body: JSON.stringify({ schema: 'keryx.execution_decision.v1', selected_option_id: 'o1' }) },
          {
            body: JSON.stringify({
              schema: 'keryx.outcome.v1',
              executed_option_id: 'summarise_group',
              result_summary: 'Summarised 2 posts.',
              result_delivery: 'digest',
              digest_category: 'Facebook',
              changed_state: null,
              delivered_via: null,
              completed_at: '2026-06-25T08:00:00+10:00',
            }),
          },
          { body: 'not json' },
        ],
      },
    ];

    const outcomes = extractOutcomes(tasks);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0].result_summary).toBe('Summarised 2 posts.');
  });
});

describe('opsctl digest command', () => {
  const outcomeComment = {
    schema: 'keryx.outcome.v1',
    executed_option_id: 'summarise_group',
    result_summary: 'Summarised 3 new posts.',
    result_delivery: 'digest',
    digest_category: '📰 Facebook',
    changed_state: null,
    delivered_via: null,
    completed_at: '2026-06-25T08:00:00+10:00',
  };

  it('renders a grouped digest with --preview without sending', async () => {
    const runner = vi.fn<HermesRunner>(async () => ({
      stdout: JSON.stringify([{ id: 't_done', status: 'done', comments: [{ body: JSON.stringify(outcomeComment) }] }]),
      stderr: '',
      exitCode: 0,
    }));

    const result = await runOpsctl(['digest', '--preview'], {
      config: loadConfig({ env: {}, configPath: null }),
      hermesRunner: runner,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('📰 FACEBOOK');
    expect(result.stdout).toContain('• Summarised 3 new posts.');
    // --preview must never send.
    expect(runner.mock.calls.some(([request]) => request.args[0] === 'send')).toBe(false);
  });

  it('prints [SILENT] with --preview when no outcomes are pending', async () => {
    const runner = vi.fn<HermesRunner>(async () => ({ stdout: JSON.stringify([]), stderr: '', exitCode: 0 }));

    const result = await runOpsctl(['digest', '--preview'], {
      config: loadConfig({ env: {}, configPath: null }),
      hermesRunner: runner,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('[SILENT]');
  });

  it('fails clearly when asked to send without a configured notify_target', async () => {
    const runner = vi.fn<HermesRunner>(async () => ({
      stdout: JSON.stringify([{ id: 't_done', status: 'done', comments: [{ body: JSON.stringify(outcomeComment) }] }]),
      stderr: '',
      exitCode: 0,
    }));

    const result = await runOpsctl(['digest'], {
      config: loadConfig({ env: {}, configPath: null }),
      hermesRunner: runner,
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('FAIL');
    expect(result.stderr).toContain('notify_target');
    expect(result.stderr).toContain('--preview');
    expect(runner.mock.calls.some(([request]) => request.args[0] === 'send')).toBe(false);
  });

  it('sends the composed digest via hermes send to the configured notify_target', async () => {
    const runner = vi.fn<HermesRunner>(async (request) => {
      if (request.args[0] === 'send') {
        return { stdout: 'sent', stderr: '', exitCode: 0 };
      }
      return {
        stdout: JSON.stringify([{ id: 't_done', status: 'done', comments: [{ body: JSON.stringify(outcomeComment) }] }]),
        stderr: '',
        exitCode: 0,
      };
    });

    const result = await runOpsctl(['digest'], {
      config: { ...loadConfig({ env: {}, configPath: null }), notifyTarget: 'telegram' },
      hermesRunner: runner,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('📰 FACEBOOK');
    expect(result.stdout).toContain('• Summarised 3 new posts.');

    const sendCall = runner.mock.calls.find(([request]) => request.args[0] === 'send');
    expect(sendCall).toBeDefined();
    expect(sendCall?.[0].args).toEqual(['send', '--to', 'telegram', expect.stringContaining('📰 FACEBOOK')]);
  });

  it('sends nothing when there are no outcomes to report (non-preview [SILENT])', async () => {
    const runner = vi.fn<HermesRunner>(async () => ({ stdout: JSON.stringify([]), stderr: '', exitCode: 0 }));

    const result = await runOpsctl(['digest'], {
      config: { ...loadConfig({ env: {}, configPath: null }), notifyTarget: 'telegram' },
      hermesRunner: runner,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('[SILENT]');
    expect(runner.mock.calls.some(([request]) => request.args[0] === 'send')).toBe(false);
  });
});
