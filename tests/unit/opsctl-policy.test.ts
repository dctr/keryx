import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { loadConfig } from '../../src/config';
import { runOpsctl } from '../../src/opsctl/commands';
import { sampleActionItem } from '../helpers/sampleActionItem';
import type { HermesRunner, KanbanTask } from '../../src/hermes/types';
import type { Policy } from '../../src/schemas/policy';

const policyWithRule: Policy = {
  schema: 'keryx.policy.v1',
  collector: 'keryx-email',
  version: 3,
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
    {
      id: 'r-002',
      class: 'email:auto-archive',
      gate: { max_blast_radius: 'self', min_reversibility: 'reversible', min_confidence: 'warming' },
      disposition: 'silent',
      state: 'shadow',
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
  const home = mkdtempSync(join(tmpdir(), 'keryx-policy-cmd-'));
  const dir = join(home, 'skills', 'keryx-collector-email', 'references');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'policy.json'), JSON.stringify(policy), 'utf8');
  return home;
}

function writeTempJson(value: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'keryx-policy-file-'));
  const path = join(dir, 'policy.json');
  writeFileSync(path, JSON.stringify(value), 'utf8');
  return path;
}

function listRunner(tasks: KanbanTask[]): HermesRunner {
  return vi.fn<HermesRunner>(async (request) => {
    if (request.args[3] === 'list') {
      return { stdout: JSON.stringify(tasks), stderr: '', exitCode: 0 };
    }
    return { stdout: '[]', stderr: '', exitCode: 0 };
  });
}

describe('opsctl policy show', () => {
  it('prints active and shadow rules with derived track-record bands', async () => {
    const home = homeWithPolicy(policyWithRule);
    const tasks: KanbanTask[] = [
      {
        id: 't1',
        status: 'done',
        body: JSON.stringify(
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
                execution_prompt: 'Unsubscribe from the newsletter.',
              },
            ],
            ui: { primary_option_id: 'unsubscribe', display_group: 'Monitored' },
          }),
        ),
        comments: [
          {
            body: JSON.stringify({
              schema: 'keryx.execution_decision.v1',
              selected_option_id: 'unsubscribe',
              user_feedback: null,
              approved_by: 'User',
              approved_via: 'keryx-web',
              approved_at: '2026-06-25T08:00:00+10:00',
            }),
          },
        ],
      },
    ];

    const result = await runOpsctl(['policy', 'show', 'keryx-email'], {
      config: loadConfig({ env: {}, configPath: null, overrides: { hermesHome: home } }),
      hermesRunner: listRunner(tasks),
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('keryx-email');
    expect(result.stdout).toContain('r-001');
    expect(result.stdout).toContain('active');
    expect(result.stdout).toContain('r-002');
    expect(result.stdout).toContain('shadow');
    expect(result.stdout).toContain('email:newsletter-unsubscribe');
  });

  it('emits machine-readable JSON with --json including derived bands', async () => {
    const home = homeWithPolicy(policyWithRule);
    const result = await runOpsctl(['policy', 'show', 'keryx-email', '--json'], {
      config: loadConfig({ env: {}, configPath: null, overrides: { hermesHome: home } }),
      hermesRunner: listRunner([]),
    });

    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout) as {
      collector: string;
      exists: boolean;
      rules: Array<{ id: string; state: string }>;
      track_record: Record<string, { band: string }>;
    };
    expect(parsed.collector).toBe('keryx-email');
    expect(parsed.exists).toBe(true);
    expect(parsed.rules.map((rule) => rule.id)).toEqual(['r-001', 'r-002']);
  });

  it('reports an absent policy as empty rather than failing', async () => {
    const home = mkdtempSync(join(tmpdir(), 'keryx-policy-empty-'));
    const result = await runOpsctl(['policy', 'show', 'keryx-email', '--json'], {
      config: loadConfig({ env: {}, configPath: null, overrides: { hermesHome: home } }),
      hermesRunner: listRunner([]),
    });

    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout) as { exists: boolean; rules: unknown[] };
    expect(parsed.exists).toBe(false);
    expect(parsed.rules).toEqual([]);
  });

  it('surfaces a malformed policy file as a FAIL', async () => {
    const home = homeWithPolicy({ schema: 'keryx.policy.v1', collector: 'keryx-email' });
    const result = await runOpsctl(['policy', 'show', 'keryx-email'], {
      config: loadConfig({ env: {}, configPath: null, overrides: { hermesHome: home } }),
      hermesRunner: listRunner([]),
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('FAIL invalid policy');
  });

  it('requires a collector argument', async () => {
    const result = await runOpsctl(['policy', 'show'], { env: {}, configPath: null });
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('FAIL policy show requires a collector');
  });
});

describe('opsctl policy validate', () => {
  it('accepts a schema-valid policy file', async () => {
    const path = writeTempJson(policyWithRule);
    const result = await runOpsctl(['policy', 'validate', path], { env: {}, configPath: null });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('OK valid policy: keryx-email');
  });

  it('rejects an invalid policy file', async () => {
    const path = writeTempJson({ schema: 'keryx.policy.v1', collector: 'keryx-email' });
    const result = await runOpsctl(['policy', 'validate', path], { env: {}, configPath: null });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('FAIL invalid policy');
  });

  it('requires a file path', async () => {
    const result = await runOpsctl(['policy', 'validate'], { env: {}, configPath: null });
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('FAIL policy validate requires a JSON file path');
  });
});

describe('opsctl policy', () => {
  it('rejects an unknown subcommand', async () => {
    const result = await runOpsctl(['policy', 'frobnicate'], { env: {}, configPath: null });
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('FAIL policy requires one of');
  });
});

describe('opsctl policy revoke', () => {
  function createRunner(): HermesRunner {
    return vi.fn<HermesRunner>(async (request) => {
      if (request.args[3] === 'create') {
        return { stdout: JSON.stringify({ id: 't_revoke' }), stderr: '', exitCode: 0 };
      }
      if (['block', 'assign', 'comment'].includes(request.args[3])) {
        return { stdout: '', stderr: '', exitCode: 0 };
      }
      return { stdout: '{}', stderr: '', exitCode: 0 };
    });
  }

  it('creates a blocked revocation card for an existing rule', async () => {
    const home = homeWithPolicy(policyWithRule);
    const runner = createRunner();
    const result = await runOpsctl(['policy', 'revoke', 'keryx-email', '--rule', 'r-001'], {
      config: loadConfig({ env: {}, configPath: null, overrides: { hermesHome: home } }),
      hermesRunner: runner,
      now: () => new Date('2026-06-26T09:00:00.000Z'),
    });

    expect(result.exitCode).toBe(0);
    const createCall = (runner as ReturnType<typeof vi.fn>).mock.calls.find((call) => call[0].args[3] === 'create');
    expect(createCall).toBeDefined();
    const body = JSON.parse(createCall![0].args[6]);
    expect(body).toMatchObject({
      schema: 'keryx.action_item.v2',
      class: 'policy:rule-revocation',
    });
    expect(body.idempotency_key).toBe('keryx:policy-revocation:keryx-email:r-001');
    expect(body.options[0].execution_prompt).toContain('r-001');
  });

  it('fails when the rule id is not in the collector policy', async () => {
    const home = homeWithPolicy(policyWithRule);
    const result = await runOpsctl(['policy', 'revoke', 'keryx-email', '--rule', 'r-999'], {
      config: loadConfig({ env: {}, configPath: null, overrides: { hermesHome: home } }),
      hermesRunner: createRunner(),
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('FAIL policy revoke: no rule r-999');
  });

  it('requires a collector and a --rule', async () => {
    const noCollector = await runOpsctl(['policy', 'revoke'], { env: {}, configPath: null });
    expect(noCollector.exitCode).toBe(2);
    expect(noCollector.stderr).toContain('FAIL policy revoke requires a collector');

    const noRule = await runOpsctl(['policy', 'revoke', 'keryx-email'], { env: {}, configPath: null });
    expect(noRule.exitCode).toBe(2);
    expect(noRule.stderr).toContain('FAIL policy revoke requires --rule');
  });
});
