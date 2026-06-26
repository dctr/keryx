import { describe, expect, it } from 'vitest';

import {
  DEFAULT_BAND_THRESHOLDS,
  type TrackRecord,
  deriveBand,
} from '../../src/policy/confidence';

function tr(overrides: Partial<TrackRecord> = {}): TrackRecord {
  return { approved: 0, overridden: 0, dismissed: 0, regret: 0, ...overrides };
}

describe('deriveBand', () => {
  it('returns cold when there are no approvals', () => {
    expect(deriveBand(tr())).toBe('cold');
  });

  it('returns cold below the warming approval threshold', () => {
    expect(deriveBand(tr({ approved: DEFAULT_BAND_THRESHOLDS.warmingApprovals - 1 }))).toBe('cold');
  });

  it('returns warming at the warming threshold with no recent regret', () => {
    expect(deriveBand(tr({ approved: DEFAULT_BAND_THRESHOLDS.warmingApprovals }))).toBe('warming');
  });

  it('returns warming below the trusted threshold even with a clean record', () => {
    expect(
      deriveBand(tr({ approved: DEFAULT_BAND_THRESHOLDS.trustedApprovals - 1 })),
    ).toBe('warming');
  });

  it('returns trusted at the trusted threshold with override rate under the cap and no regret', () => {
    expect(deriveBand(tr({ approved: DEFAULT_BAND_THRESHOLDS.trustedApprovals }))).toBe('trusted');
  });

  it('does not return trusted when the override rate exceeds the cap', () => {
    // 10 approved + 5 overridden -> override rate 0.33 > 0.15 cap.
    expect(deriveBand(tr({ approved: 10, overridden: 5 }))).toBe('warming');
  });

  it('returns trusted when the override rate is exactly at the cap', () => {
    // 17 approved + 3 overridden -> override rate 0.15 == cap.
    expect(deriveBand(tr({ approved: 17, overridden: 3 }))).toBe('trusted');
  });

  it('forces at most warming when there is any recent regret', () => {
    expect(
      deriveBand(tr({ approved: DEFAULT_BAND_THRESHOLDS.trustedApprovals, regret: 1 })),
    ).toBe('warming');
  });

  it('forces cold when there is recent regret and too few approvals', () => {
    expect(
      deriveBand(tr({ approved: DEFAULT_BAND_THRESHOLDS.warmingApprovals - 1, regret: 1 })),
    ).toBe('cold');
  });

  it('honours custom thresholds', () => {
    const thresholds = { warmingApprovals: 1, trustedApprovals: 2, maxOverrideRate: 0.5 };
    expect(deriveBand(tr({ approved: 1 }), thresholds)).toBe('warming');
    expect(deriveBand(tr({ approved: 2, overridden: 1 }), thresholds)).toBe('trusted');
    expect(deriveBand(tr({ approved: 2, overridden: 3 }), thresholds)).toBe('warming');
  });

  it('treats dismissals as neutral to the band (they do not raise confidence)', () => {
    expect(deriveBand(tr({ dismissed: 20 }))).toBe('cold');
  });
});
