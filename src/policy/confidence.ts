// Confidence band model (PRD §7.3). Pure module: maps a per-(collector, class)
// track record derived from the Kanban audit trail to a confidence band. The band
// scopes which silent disposition the grid (src/policy/disposition.ts) allows.
//
// Thresholds are configuration (PRD §16 q2), not schema: they default to the
// constants below and later read from keryx.config.json. Confidence is never a
// card field — it is computed here from history, so a collector cannot manipulate it.

export type Band = 'cold' | 'warming' | 'trusted';

export interface TrackRecord {
  approved: number;
  overridden: number;
  dismissed: number;
  regret: number;
}

export interface BandThresholds {
  warmingApprovals: number;
  trustedApprovals: number;
  maxOverrideRate: number;
}

export const DEFAULT_BAND_THRESHOLDS: BandThresholds = {
  warmingApprovals: 3,
  trustedApprovals: 10,
  maxOverrideRate: 0.15,
};

export function deriveBand(tr: TrackRecord, t: BandThresholds = DEFAULT_BAND_THRESHOLDS): Band {
  // Any recent regret caps the band at warming and otherwise pulls it down: a
  // class the user has flagged as a mistake cannot be trusted for silent runs.
  if (tr.regret > 0) {
    return tr.approved >= t.warmingApprovals ? 'warming' : 'cold';
  }

  const total = tr.approved + tr.overridden;
  const overrideRate = total === 0 ? 1 : tr.overridden / total;

  if (tr.approved >= t.trustedApprovals && overrideRate <= t.maxOverrideRate) {
    return 'trusted';
  }
  if (tr.approved >= t.warmingApprovals) {
    return 'warming';
  }
  return 'cold';
}
