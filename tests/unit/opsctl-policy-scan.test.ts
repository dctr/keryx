import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { loadConfig } from '../../src/config';
import { runOpsctl } from '../../src/opsctl/commands';
import { validateActionItem } from '../../src/schemas/actionItem';
import { sampleActionItem } from '../helpers/sampleActionItem';
import type { HermesRunner, KanbanTask } from '../../src/hermes/types';
import type { Policy } from '../../src/schemas/policy';

const policyWithShadowAndActiveRule: Policy = {
  schema: 'keryx.policy.v1',
  collector: 'keryx-email',
  version: 3,
  updated_at: '2026-06-25T09:00:00Z',
  rules: [
    {
      id: 'r-shadow',
      class: 'email:newsletter-unsubscribe',
      gate: { max_blast_radius: 'self', min_reversibility: 'reversible', min_confidence: 'trusted' },
      disposition: 'silent',
      result_delivery: 'digest',
      state: 'shadow',
      approved_by: 'User',
      approved_at: '2026-06-25T09:00:00Z',
      source_card_id: null,
      scope_note: null,
    },
    {
      id: 'r-active',
      class: 'email:auto-archive',
      gate: { max_blast_radius: 'self', min_reversibility: 'reversible', min_confidence: 'trusted' },
      disposition: 'silent',
      result_delivery: 'digest',
      state: 'active',
      approved_by: 'User',
      approved_at: '2026-06-25T09:00:00Z',
      source_card_id: null,
      scope_note: null,
    },
  ],
  thresholds: { spend_requires_approval_always: true },
  track_record: {},
};

function homeWithPolicy(policy: unknown): string {
  const home = mkdtempSync(join(tmpdir(), 'keryx-policy-scan-'));
  const dir = join(home, 'skills', 'keryx-collector-email', 'references');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'policy.json'), JSON.stringify(policy), 'utf8');
  return home;
}

function listRunner(tasks: KanbanTask[], createdBodies: string[] = []): HermesRunner {
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
    if (request.args[3] === 'create') {
      createdBodies.push(request.args[6]);
      return { stdout: JSON.stringify({ id: `t_created_${createdBodies.length}`, status: 'ready' }), stderr: '', exitCode: 0 };
    }
    if (['block', 'assign', 'comment'].includes(request.args[3])) {
      return { stdout: '', stderr: '', exitCode: 0 };
    }
    return { stdout: '{}', stderr: '', exitCode: 0 };
  });
}

describe('opsctl policy scan', () => {
  it('supports preview mode as read-only JSON output', async () => {
    const home = homeWithPolicy(policyWithShadowAndActiveRule);
    const tasks: KanbanTask[] = [
      {
        id: 't_cold',
        status: 'done',
        created_at: '2026-07-05T00:00:00.000Z',
        body: JSON.stringify(sampleActionItem({ collector: 'keryx-email', class: 'email:auto-archive' })),
        comments: [
          {
            created_at: '2026-07-05T00:01:00.000Z',
            body: JSON.stringify({
              schema: 'keryx.regret.v1',
              kind: 'should_have_asked',
              note: null,
              recorded_by: 'User',
              recorded_at: '2026-07-05T00:01:00.000Z',
            }),
          },
        ],
      },
    ];

    const createdBodies: string[] = [];
    const runner = listRunner(tasks, createdBodies);
    const result = await runOpsctl(['policy', 'scan', 'keryx-email', '--preview', '--json'], {
      config: loadConfig({ env: {}, configPath: null, overrides: { hermesHome: home } }),
      hermesRunner: runner,
    });

    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout) as {
      collector: string;
      preview: boolean;
      proposals: Array<{ kind: string; class: string; targetState: string; latestReset: { kind: string } | null }>;
    };
    expect(parsed.collector).toBe('keryx-email');
    expect(parsed.preview).toBe(true);
    expect(parsed.proposals).toContainEqual(
      expect.objectContaining({ kind: 'demote', class: 'email:auto-archive', targetState: 'revoked' }),
    );
    const demotion = parsed.proposals.find((proposal) => proposal.class === 'email:auto-archive');
    expect(demotion?.latestReset).toMatchObject({ kind: 'regret' });

    const verbs = (runner as ReturnType<typeof vi.fn>).mock.calls.map(([request]) => request.args[3]);
    expect(verbs).not.toContain('create');
    expect(createdBodies).toHaveLength(0);
  });

  it('creates graduation and demotion proposal cards with evidence and safety text', async () => {
    const home = homeWithPolicy(policyWithShadowAndActiveRule);
    const decisionComments = Array.from({ length: 10 }, () => ({
      body: JSON.stringify({
        schema: 'keryx.execution_decision.v1',
        selected_option_id: 'translate_forward_contact_archive',
        user_feedback: null,
        approved_by: 'User',
        approved_via: 'keryx-web',
        approved_at: '2026-07-05T01:00:00.000Z',
      }),
    }));

    const tasks: KanbanTask[] = [
      {
        id: 't_trusted',
        status: 'done',
        body: JSON.stringify(sampleActionItem({ collector: 'keryx-email', class: 'email:newsletter-unsubscribe' })),
        comments: decisionComments,
      },
      {
        id: 't_cold',
        status: 'done',
        created_at: '2026-07-05T00:00:00.000Z',
        body: JSON.stringify(sampleActionItem({ collector: 'keryx-email', class: 'email:auto-archive' })),
        comments: [
          {
            created_at: '2026-07-05T00:01:00.000Z',
            body: JSON.stringify({
              schema: 'keryx.regret.v1',
              kind: 'should_have_asked',
              note: null,
              recorded_by: 'User',
              recorded_at: '2026-07-05T00:01:00.000Z',
            }),
          },
        ],
      },
    ];

    const createdBodies: string[] = [];
    const result = await runOpsctl(['policy', 'scan', 'keryx-email'], {
      config: loadConfig({ env: {}, configPath: null, overrides: { hermesHome: home, defaultAssignee: 'default' } }),
      hermesRunner: listRunner(tasks, createdBodies),
      now: () => new Date('2026-07-06T00:00:00.000Z'),
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('OK policy scan created 2 proposal card(s)');
    expect(createdBodies).toHaveLength(2);

    const cards = createdBodies.map((body) => JSON.parse(body) as unknown);
    for (const card of cards) {
      const validation = validateActionItem(card);
      expect(validation.ok).toBe(true);
    }

    const classes = cards.map((card) => (card as { class: string }).class).sort();
    expect(classes).toEqual(['policy:rule-proposal', 'policy:rule-revocation']);

    const revocation = cards.find((card) => (card as { class: string }).class === 'policy:rule-revocation') as {
      summary: string;
    };
    expect(revocation.summary).toContain('latest_reset=');
    expect(revocation.summary).toContain('fall back to review');

    const proposal = cards.find((card) => (card as { class: string }).class === 'policy:rule-proposal') as {
      summary: string;
    };
    expect(proposal.summary).toContain('Risk bounds:');
    expect(proposal.summary).toContain('Exclusions:');
    expect(proposal.summary).toContain('Digest behavior:');
    expect(proposal.summary).toContain('Undo/correction path:');
  });

  it('does not auto-propose first shadow rules when no policy skeleton exists', async () => {
    const home = mkdtempSync(join(tmpdir(), 'keryx-policy-scan-empty-'));
    const decisionComments = Array.from({ length: 10 }, () => ({
      body: JSON.stringify({
        schema: 'keryx.execution_decision.v1',
        selected_option_id: 'translate_forward_contact_archive',
        user_feedback: null,
        approved_by: 'User',
        approved_via: 'keryx-web',
        approved_at: '2026-07-05T01:00:00.000Z',
      }),
    }));
    const tasks: KanbanTask[] = [
      {
        id: 't_trusted',
        status: 'done',
        body: JSON.stringify(sampleActionItem({ collector: 'keryx-email', class: 'email:newsletter-unsubscribe' })),
        comments: decisionComments,
      },
    ];

    const result = await runOpsctl(['policy', 'scan', 'keryx-email', '--preview', '--json'], {
      config: loadConfig({ env: {}, configPath: null, overrides: { hermesHome: home } }),
      hermesRunner: listRunner(tasks),
    });

    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout) as { policy_exists: boolean; proposals: unknown[] };
    expect(parsed.policy_exists).toBe(false);
    expect(parsed.proposals).toEqual([]);
  });

  it('requires a collector argument', async () => {
    const result = await runOpsctl(['policy', 'scan'], { env: {}, configPath: null });
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('FAIL policy scan requires a collector');
  });
});
