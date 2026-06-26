import { describe, expect, it } from 'vitest';

import { computePromotionIntents } from '../../src/policy/promotion';
import type { TrackRecord } from '../../src/policy/confidence';
import type { PolicyRule } from '../../src/schemas/policy';

function rule(overrides: Partial<PolicyRule> & Pick<PolicyRule, 'id' | 'class' | 'state'>): PolicyRule {
  return {
    gate: { max_blast_radius: 'self', min_reversibility: 'reversible', min_confidence: 'trusted' },
    disposition: 'silent',
    result_delivery: 'digest',
    approved_by: 'User',
    approved_at: '2026-06-25T09:00:00Z',
    source_card_id: null,
    scope_note: null,
    ...overrides,
  };
}

const trusted: TrackRecord = { approved: 14, overridden: 1, dismissed: 0, regret: 0 };
const warming: TrackRecord = { approved: 5, overridden: 0, dismissed: 0, regret: 0 };
const trustedWithRegret: TrackRecord = { approved: 14, overridden: 1, dismissed: 0, regret: 1 };

describe('computePromotionIntents', () => {
  it('proposes shadow -> active when a shadow rule class reaches trusted', () => {
    const intents = computePromotionIntents(
      { 'email:unsub': trusted },
      [rule({ id: 'r-1', class: 'email:unsub', state: 'shadow' })],
    );
    expect(intents).toHaveLength(1);
    expect(intents[0]).toMatchObject({
      kind: 'promote',
      class: 'email:unsub',
      band: 'trusted',
      currentState: 'shadow',
      targetState: 'active',
      ruleId: 'r-1',
    });
  });

  it('proposes a first shadow rule when a ruleless class reaches trusted', () => {
    const intents = computePromotionIntents({ 'email:unsub': trusted }, []);
    expect(intents).toHaveLength(1);
    expect(intents[0]).toMatchObject({
      kind: 'promote',
      class: 'email:unsub',
      currentState: null,
      targetState: 'shadow',
      ruleId: null,
    });
  });

  it('does not propose promotion for a class that is only warming', () => {
    const intents = computePromotionIntents({ 'email:unsub': warming }, []);
    expect(intents).toEqual([]);
  });

  it('does not re-propose promotion when an active rule already exists', () => {
    const intents = computePromotionIntents(
      { 'email:unsub': trusted },
      [rule({ id: 'r-1', class: 'email:unsub', state: 'active' })],
    );
    expect(intents).toEqual([]);
  });

  it('demotes an active rule to shadow when its band falls below trusted', () => {
    const intents = computePromotionIntents(
      { 'email:unsub': trustedWithRegret },
      [rule({ id: 'r-1', class: 'email:unsub', state: 'active' })],
    );
    expect(intents).toHaveLength(1);
    expect(intents[0]).toMatchObject({
      kind: 'demote',
      class: 'email:unsub',
      currentState: 'active',
      targetState: 'shadow',
      ruleId: 'r-1',
    });
    expect(intents[0].band).not.toBe('trusted');
  });

  it('returns no intents when nothing crosses a threshold', () => {
    const intents = computePromotionIntents(
      { 'email:unsub': warming },
      [rule({ id: 'r-1', class: 'email:auto-archive', state: 'shadow' })],
    );
    expect(intents).toEqual([]);
  });
});
