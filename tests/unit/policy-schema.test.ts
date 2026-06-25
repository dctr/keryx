import { describe, expect, it } from 'vitest';

import { validatePolicy } from '../../src/schemas/policy';
import type { Policy } from '../../src/schemas/policy';

const validPolicy: Policy = {
  schema: 'keryx.policy.v1',
  collector: 'keryx-email',
  version: 1,
  updated_at: '2026-05-31T12:34:56.000Z',
  rules: [
    {
      id: 'rule-newsletter-unsubscribe',
      class: 'email:newsletter-unsubscribe',
      gate: { max_blast_radius: 'self', min_reversibility: 'reversible', min_confidence: 'trusted' },
      disposition: 'silent',
      result_delivery: 'digest',
      state: 'shadow',
      approved_by: 'User',
      approved_at: '2026-05-31T12:34:56.000Z',
      source_card_id: 't_policy_card',
      scope_note: 'Only newsletters, never transactional mail.',
    },
  ],
  thresholds: { spend_requires_approval_always: true },
  track_record: {
    'email:newsletter-unsubscribe': {
      approved: 12,
      overridden: 1,
      dismissed: 0,
      regret: 0,
      band: 'trusted',
      updated_at: '2026-05-31T12:34:56.000Z',
    },
  },
};

describe('policy.v1 validation', () => {
  it('accepts a fully-specified collector policy', () => {
    expect(validatePolicy(validPolicy)).toEqual({ ok: true, value: validPolicy });
  });

  it('accepts an empty policy with no rules or track record', () => {
    const empty: Policy = { ...validPolicy, rules: [], track_record: {} };
    expect(validatePolicy(empty).ok).toBe(true);
  });

  it('rejects a rule with an unknown disposition', () => {
    const malformed = {
      ...validPolicy,
      rules: [{ ...validPolicy.rules[0], disposition: 'auto' }],
    };
    expect(validatePolicy(malformed).ok).toBe(false);
  });

  it('rejects a rule whose gate omits min_confidence', () => {
    const gate = { ...validPolicy.rules[0].gate } as Record<string, unknown>;
    delete gate.min_confidence;
    const malformed = { ...validPolicy, rules: [{ ...validPolicy.rules[0], gate }] };
    expect(validatePolicy(malformed).ok).toBe(false);
  });

  it('rejects a thresholds object with unknown keys', () => {
    const malformed = {
      ...validPolicy,
      thresholds: { spend_requires_approval_always: true, surprise: true },
    };
    expect(validatePolicy(malformed).ok).toBe(false);
  });

  it('rejects a track-record entry with an unknown band', () => {
    const malformed = {
      ...validPolicy,
      track_record: { 'email:newsletter-unsubscribe': { ...validPolicy.track_record['email:newsletter-unsubscribe'], band: 'hot' } },
    };
    expect(validatePolicy(malformed).ok).toBe(false);
  });

  it('rejects a collector that does not match the keryx- prefix', () => {
    expect(validatePolicy({ ...validPolicy, collector: 'email' }).ok).toBe(false);
  });
});
