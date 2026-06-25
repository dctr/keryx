// Deterministic disposition function (PRD §7.2 / §7.8 judgment layer).
//
// Pure module. Inputs: the v2 card evidence + the selected option + the looked-up
// confidence band for (collector, class) + the collector's approved policy. Output:
// a fully-reasoned disposition. The function never *upgrades* on a card's say-so; it
// only grants silent/interrupt when the risk axes, band, and an approved rule allow.
//
// Decision order (first match wins; default is the most cautious — §7.2):
//   1. Absolute floor   -> never silent (review, or interrupt when time-pressured).
//   2. Interrupt        -> urgent/soon + external (or a read_only finding that is
//                          time-sensitive), or an active interrupt rule.
//   3. Silent read_only -> read_only options mutate nothing; silent by design.
//   4. Silent action    -> band meets the grid floor AND an active rule authorizes
//                          this (collector, class) within the option's axes.
//   5. Default          -> review (blocked; waits in the dashboard).

import type { ActionItem, ActionOption, Disposition, ResultDelivery } from '../schemas/actionItem';
import type { Band } from './confidence';
import type { Policy, PolicyRule } from '../schemas/policy';

export type { Disposition };

export interface DispositionResult {
  disposition: Disposition;
  tier: 1 | 2 | 3 | 4 | 5 | 6;
  result_delivery: ResultDelivery;
  reasons: string[];
  requires_monitor: boolean;
  rule_id: string | null;
  shadow: boolean; // true when an otherwise-silent rule is still in shadow
}

const REV_RANK = { read_only: 0, reversible: 1, compensable: 2, irreversible: 3 } as const;
const BLAST_RANK = { self: 0, external: 1 } as const;
const BAND_RANK = { cold: 0, warming: 1, trusted: 2 } as const;

function bandMeets(band: Band, required: Band): boolean {
  return BAND_RANK[band] >= BAND_RANK[required];
}

function maxBand(a: Band, b: Band): Band {
  return BAND_RANK[a] >= BAND_RANK[b] ? a : b;
}

// The confidence the grid (§7.2) demands to run a state-changing option silently.
// read_only needs none (handled before step 4); self+reversible needs warming;
// every more-committed or external cell needs trusted (+ an explicit promotion rule).
function gridFloor(blast: ActionOption['blast_radius'], rev: ActionOption['reversibility']): Band {
  if (rev === 'read_only') return 'cold';
  if (blast === 'self' && rev === 'reversible') return 'warming';
  return 'trusted';
}

// A rule covers an option only if the option's axes sit within the rule's gate:
// blast_radius no wider than max_blast_radius, commitment no greater than min_reversibility.
function gateAllows(rule: PolicyRule, selected: ActionOption): boolean {
  return (
    BLAST_RANK[selected.blast_radius] <= BLAST_RANK[rule.gate.max_blast_radius] &&
    REV_RANK[selected.reversibility] <= REV_RANK[rule.gate.min_reversibility]
  );
}

function matchRule(
  policy: Policy | null,
  cls: string,
  selected: ActionOption,
  disposition: Disposition,
): PolicyRule | undefined {
  if (!policy) return undefined;
  return policy.rules.find(
    (r) => r.class === cls && r.disposition === disposition && gateAllows(r, selected),
  );
}

function deliveryOf(item: ActionItem, rule?: PolicyRule | null): ResultDelivery {
  return item.result_delivery ?? rule?.result_delivery ?? 'digest';
}

function silentTier(delivery: ResultDelivery): 1 | 2 | 4 {
  if (delivery === 'log_only') return 1; // tier 1 — review log only
  if (delivery === 'push') return 4; // tier 4 — push the time-sensitive result
  return 2; // tier 2 — digest of outcomes (default)
}

function interrupt(
  item: ActionItem,
  reasons: string[],
  ruleId: string | null = null,
): DispositionResult {
  return {
    disposition: 'interrupt',
    tier: item.urgency === 'urgent' ? 5 : 4,
    result_delivery: deliveryOf(item),
    reasons,
    requires_monitor: false,
    rule_id: ruleId,
    shadow: false,
  };
}

function review(item: ActionItem, reasons: string[]): DispositionResult {
  return {
    disposition: 'review',
    tier: 3,
    result_delivery: deliveryOf(item),
    reasons,
    requires_monitor: false,
    rule_id: null,
    shadow: false,
  };
}

function silent(
  item: ActionItem,
  reasons: string[],
  rule: PolicyRule | null,
  shadow: boolean,
): DispositionResult {
  const delivery = deliveryOf(item, rule);
  return {
    disposition: 'silent',
    tier: silentTier(delivery),
    result_delivery: delivery,
    reasons,
    requires_monitor: false,
    rule_id: rule?.id ?? null,
    shadow,
  };
}

export function decideDisposition(
  item: ActionItem,
  selected: ActionOption,
  band: Band,
  policy: Policy | null,
): DispositionResult {
  const reasons: string[] = [];
  const timePressured = item.urgency === 'urgent' || item.urgency === 'soon';

  // 1. Absolute floor — money/destructive/credential gate is never silent.
  const floor = selected.absolute_floor ?? [];
  if (floor.length > 0) {
    reasons.push(`absolute_floor=${floor.join(',')} -> never silent`);
    if (timePressured) {
      reasons.push('time-pressured floor -> interrupt');
      return interrupt(item, reasons);
    }
    return review(item, reasons);
  }

  // 2. Interrupt — urgent/soon external action, a time-sensitive read_only finding,
  //    or an explicit active interrupt rule.
  const interruptRule = matchRule(policy, item.class, selected, 'interrupt');
  if (timePressured && selected.blast_radius === 'external') {
    reasons.push(`${item.urgency}+external -> interrupt`);
    return interrupt(item, reasons, interruptRule?.id ?? null);
  }
  if (timePressured && selected.reversibility === 'read_only') {
    reasons.push(`${item.urgency} read_only finding is time-sensitive -> interrupt`);
    return interrupt(item, reasons, interruptRule?.id ?? null);
  }
  if (interruptRule?.state === 'active') {
    reasons.push(`active rule ${interruptRule.id} forces interrupt`);
    return interrupt(item, reasons, interruptRule.id);
  }

  // 3. Silent (read_only) — mutates nothing, exercises no authority; no rule required.
  if (selected.reversibility === 'read_only') {
    reasons.push('read_only -> silent by design');
    return silent(item, reasons, null, false);
  }

  // 4. Silent (state-changing) — needs the grid floor met by the band AND an active
  //    rule whose gate covers the option and whose own min_confidence the band meets.
  const rule = matchRule(policy, item.class, selected, 'silent');
  if (rule) {
    const required = maxBand(
      gridFloor(selected.blast_radius, selected.reversibility),
      rule.gate.min_confidence,
    );
    if (bandMeets(band, required)) {
      if (rule.state === 'active') {
        reasons.push(`active rule ${rule.id} authorizes silent`);
        return silent(item, reasons, rule, false);
      }
      reasons.push(`shadow rule ${rule.id}: would have run silently`);
      return { ...review(item, reasons), shadow: true, rule_id: rule.id };
    }
    reasons.push(`band ${band} below ${required} required for rule ${rule.id} -> review`);
  }

  // 5. Default -> review (blocked; waits in the dashboard).
  reasons.push('no covering rule -> review');
  const result = review(item, reasons);
  result.requires_monitor =
    band === 'cold' &&
    (selected.blast_radius === 'external' ||
      REV_RANK[selected.reversibility] >= REV_RANK.compensable);
  return result;
}
