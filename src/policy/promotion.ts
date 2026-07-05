// Promotion / demotion proposal logic (PRD §7.3, §13). Pure module: given the per-class
// track record derived from the Kanban audit trail and a collector's current rules, it
// emits structured intents describing which classes should climb (cold/warming → shadow →
// active) or fall (active → shadow on regret/override degradation). It NEVER mutates a
// policy itself: a promotion to `active` only ever lands through a human-approved
// suggestion card (the same mechanism as `policy propose`); this module just identifies
// the candidates the worker hook turns into proposals.

import { type Band, deriveBand, type TrackRecord } from './confidence';
import { splitTrackRecordKey } from './trackRecord';
import type { PolicyRule, RuleState } from '../schemas/policy';

export type PromotionTargetState = RuleState | 'revoked';

export interface PromotionIntent {
  // `promote`: the class is ready to climb a rung (no rule → shadow, or shadow → active).
  // `demote`: an `active` rule's band fell below trusted and should revert to shadow.
  kind: 'promote' | 'demote';
  class: string;
  band: Band;
  // The state of the existing rule for this class, or null when no rule exists yet.
  currentState: RuleState | null;
  targetState: PromotionTargetState;
  // The rule this intent acts on, or null when proposing a brand-new (first) rule.
  ruleId: string | null;
}

// Picks the rule that governs a class. A class should carry at most one silent rule; if
// several exist, prefer an `active` one (it is the live authority) so demotion targets it.
function ruleForClass(rules: PolicyRule[], cls: string): PolicyRule | undefined {
  const matches = rules.filter((rule) => rule.class === cls);
  return matches.find((rule) => rule.state === 'active') ?? matches[0];
}

export function computePromotionIntents(
  trackRecord: Record<string, TrackRecord>,
  rules: PolicyRule[],
  collector?: string,
): PromotionIntent[] {
  const intents: PromotionIntent[] = [];
  const scopedByClass: Record<string, TrackRecord> = {};

  for (const [key, record] of Object.entries(trackRecord)) {
    const parts = splitTrackRecordKey(key);
    if (parts.collector.length > 0) {
      if (collector && parts.collector !== collector) continue;
      scopedByClass[parts.class] = record;
      continue;
    }
    // Back-compat for legacy class-only keys.
    scopedByClass[key] = record;
  }

  // Every class appearing in the (optionally collector-scoped) track record or in
  // a rule is a promotion/demotion candidate — a rule with no history still demotes
  // if its band cannot be sustained.
  const classes = new Set<string>([...Object.keys(scopedByClass), ...rules.map((rule) => rule.class)]);

  for (const cls of classes) {
    const record: TrackRecord = scopedByClass[cls] ?? { approved: 0, overridden: 0, dismissed: 0, regret: 0 };
    const band = deriveBand(record);
    const rule = ruleForClass(rules, cls);

    if (rule?.state === 'active') {
      // Demotion: only `trusted` sustains active. A warming band demotes active -> shadow,
      // while a cold reset revokes the rule entirely (active -> revoked).
      if (band !== 'trusted') {
        intents.push({
          kind: 'demote',
          class: cls,
          band,
          currentState: 'active',
          targetState: band === 'cold' ? 'revoked' : 'shadow',
          ruleId: rule.id,
        });
      }
      continue;
    }

    // Promotion only fires at the trusted threshold (the silent bar). Warming classes
    // stay in the draft-and-approve rung and produce no intent here.
    if (band !== 'trusted') continue;

    if (rule?.state === 'shadow') {
      intents.push({ kind: 'promote', class: cls, band, currentState: 'shadow', targetState: 'active', ruleId: rule.id });
    } else {
      // No covering rule yet: propose the first (shadow) rule so the class can begin
      // shadow-mode validation before any active silent authority is granted.
      intents.push({ kind: 'promote', class: cls, band, currentState: null, targetState: 'shadow', ruleId: null });
    }
  }

  return intents;
}
