import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { runOpsctl } from '../../src/opsctl/commands';

const validPolicyDecision = {
  schema: 'keryx.policy_decision.v1',
  selected_option_id: 'summarise_group',
  disposition: 'silent',
  rule_id: null,
  reasons: ['read_only -> silent by design'],
  approved_by: 'keryx-policy',
  approved_via: 'policy:read-only',
  approved_at: '2026-06-25T08:00:00+10:00',
};

const validOutcome = {
  schema: 'keryx.outcome.v1',
  executed_option_id: 'summarise_group',
  result_summary: 'Summarised 3 new posts.',
  result_delivery: 'digest',
  digest_category: 'Facebook',
  changed_state: null,
  delivered_via: null,
  completed_at: '2026-06-25T08:00:00+10:00',
};

const validPolicy = {
  schema: 'keryx.policy.v1',
  collector: 'keryx-email',
  version: 1,
  updated_at: '2026-06-25T08:00:00+10:00',
  rules: [],
  thresholds: { spend_requires_approval_always: true },
  track_record: {},
};

const validDismissal = {
  schema: 'keryx.dismissal_decision.v1',
  dismissal_scope: 'exact_item',
  reason: null,
  dismissed_external_id: 'facebook:group:42',
  dismissed_idempotency_key: 'keryx:facebook:group:42',
  dismissed_by: 'User',
  dismissed_via: 'keryx-web',
  dismissed_at: '2026-06-25T08:00:00+10:00',
};

describe('opsctl validate-* commands for machine-written bodies', () => {
  const cases = [
    {
      command: 'validate-policy-decision',
      valid: validPolicyDecision,
      requiredField: 'disposition',
      okFragment: 'OK valid policy decision',
    },
    {
      command: 'validate-outcome',
      valid: validOutcome,
      requiredField: 'result_summary',
      okFragment: 'OK valid outcome',
    },
    {
      command: 'validate-policy',
      valid: validPolicy,
      requiredField: 'collector',
      okFragment: 'OK valid policy',
    },
    {
      command: 'validate-dismissal',
      valid: validDismissal,
      requiredField: 'dismissed_external_id',
      okFragment: 'OK valid dismissal decision',
    },
  ] as const;

  for (const testCase of cases) {
    it(`${testCase.command} accepts a valid body`, async () => {
      const filePath = writeTempJson(testCase.valid);
      const result = await runOpsctl([testCase.command, filePath], { env: {}, configPath: null });

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe('');
      expect(result.stdout).toContain(testCase.okFragment);
    });

    it(`${testCase.command} rejects a body missing ${testCase.requiredField}`, async () => {
      const malformed = { ...testCase.valid } as Record<string, unknown>;
      delete malformed[testCase.requiredField];
      const filePath = writeTempJson(malformed);

      const result = await runOpsctl([testCase.command, filePath], { env: {}, configPath: null });

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain('FAIL');
      expect(result.stderr).toContain(`must have required property '${testCase.requiredField}'`);
    });

    it(`${testCase.command} exits 2 without a file path`, async () => {
      const result = await runOpsctl([testCase.command], { env: {}, configPath: null });

      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain(`FAIL ${testCase.command} requires a JSON file path`);
    });
  }
});

function writeTempJson(value: unknown): string {
  const directory = mkdtempSync(join(tmpdir(), 'keryx-validate-'));
  const filePath = join(directory, 'body.json');
  writeFileSync(filePath, JSON.stringify(value), 'utf8');
  return filePath;
}
