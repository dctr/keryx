import { describe, expect, it } from 'vitest';

import { sampleActionItem, sampleActionOption } from '../helpers/sampleActionItem';
import type { Band } from '../../src/policy/confidence';
import { decideDisposition } from '../../src/policy/disposition';
import type {
  ActionItem,
  ActionOption,
  BlastRadius,
  Reversibility,
} from '../../src/schemas/actionItem';
import type { Policy, PolicyRule, PolicyRuleGate } from '../../src/schemas/policy';

const CLASS = 'email:newsletter-unsubscribe';

function option(overrides: Partial<ActionOption> = {}): ActionOption {
  // Default to a reversible+self option (carries an undo_prompt per the v2 contract).
  return sampleActionOption({
    id: 'opt',
    reversibility: 'reversible',
    blast_radius: 'self',
    undo_prompt: 'Undo it.',
    absolute_floor: undefined,
    ...overrides,
  });
}

function item(overrides: Partial<ActionItem> = {}): ActionItem {
  return sampleActionItem({ class: CLASS, urgency: 'normal', ...overrides });
}

function gate(overrides: Partial<PolicyRuleGate> = {}): PolicyRuleGate {
  return {
    max_blast_radius: 'external',
    min_reversibility: 'irreversible',
    min_confidence: 'warming',
    ...overrides,
  };
}

function rule(overrides: Partial<PolicyRule> = {}): PolicyRule {
  return {
    id: 'r-1',
    class: CLASS,
    gate: gate(),
    disposition: 'silent',
    state: 'active',
    approved_by: 'User',
    approved_at: '2026-06-25T00:00:00Z',
    source_card_id: null,
    scope_note: null,
    ...overrides,
  };
}

function policy(rules: PolicyRule[]): Policy {
  return {
    schema: 'keryx.policy.v1',
    collector: 'keryx-email',
    version: 1,
    updated_at: '2026-06-25T00:00:00Z',
    rules,
    thresholds: { spend_requires_approval_always: true },
    track_record: {},
  };
}

// A silent rule whose gate permits a given cell at the right confidence.
function silentRule(
  blast: BlastRadius,
  rev: Reversibility,
  minConfidence: Band,
  state: 'active' | 'shadow' = 'active',
): Policy {
  return policy([
    rule({ gate: gate({ max_blast_radius: blast, min_reversibility: rev, min_confidence: minConfidence }), state }),
  ]);
}

describe('decideDisposition — absolute floor (step 1)', () => {
  it('floor + non-urgent -> review, never silent', () => {
    const r = decideDisposition(item(), option({ absolute_floor: ['money'] }), 'trusted', null);
    expect(r.disposition).toBe('review');
    expect(r.reasons.join(' ')).toContain('absolute_floor');
  });

  it('floor + urgent -> interrupt (tier 5)', () => {
    const r = decideDisposition(item({ urgency: 'urgent' }), option({ absolute_floor: ['destructive'] }), 'trusted', null);
    expect(r.disposition).toBe('interrupt');
    expect(r.tier).toBe(5);
  });

  it('floor + soon -> interrupt (tier 4)', () => {
    const r = decideDisposition(item({ urgency: 'soon' }), option({ absolute_floor: ['money'] }), 'trusted', null);
    expect(r.disposition).toBe('interrupt');
    expect(r.tier).toBe(4);
  });

  it('floor wins even with an active silent rule', () => {
    const r = decideDisposition(
      item(),
      option({ absolute_floor: ['credential_gate'] }),
      'trusted',
      silentRule('self', 'reversible', 'warming'),
    );
    expect(r.disposition).toBe('review');
  });
});

describe('decideDisposition — interrupt (step 2)', () => {
  it('urgent + external -> interrupt tier 5', () => {
    const r = decideDisposition(item({ urgency: 'urgent' }), option({ blast_radius: 'external' }), 'cold', null);
    expect(r.disposition).toBe('interrupt');
    expect(r.tier).toBe(5);
  });

  it('soon + external -> interrupt tier 4', () => {
    const r = decideDisposition(item({ urgency: 'soon' }), option({ blast_radius: 'external' }), 'cold', null);
    expect(r.disposition).toBe('interrupt');
    expect(r.tier).toBe(4);
  });

  it('urgent + read_only finding -> interrupt (time-sensitive monitor, no authority)', () => {
    const r = decideDisposition(
      item({ urgency: 'urgent' }),
      option({ reversibility: 'read_only', blast_radius: 'self', undo_prompt: null }),
      'cold',
      null,
    );
    expect(r.disposition).toBe('interrupt');
  });

  it('an active interrupt rule forces interrupt even when not urgent', () => {
    const p = policy([rule({ id: 'r-int', disposition: 'interrupt', state: 'active' })]);
    const r = decideDisposition(item({ urgency: 'normal' }), option({ blast_radius: 'self' }), 'cold', p);
    expect(r.disposition).toBe('interrupt');
    expect(r.rule_id).toBe('r-int');
  });

  it('a shadow interrupt rule does not force interrupt', () => {
    const p = policy([rule({ id: 'r-int', disposition: 'interrupt', state: 'shadow' })]);
    const r = decideDisposition(item({ urgency: 'normal' }), option({ blast_radius: 'self' }), 'cold', p);
    expect(r.disposition).toBe('review');
  });
});

describe('decideDisposition — read_only silent (step 3)', () => {
  it('read_only + self -> silent with no rule required', () => {
    const r = decideDisposition(
      item({ urgency: 'normal' }),
      option({ reversibility: 'read_only', blast_radius: 'self', undo_prompt: null }),
      'cold',
      null,
    );
    expect(r.disposition).toBe('silent');
    expect(r.rule_id).toBeNull();
    expect(r.shadow).toBe(false);
    expect(r.reasons.join(' ')).toContain('read_only');
  });

  it('read_only low urgency -> silent, result_delivery digest by default', () => {
    const r = decideDisposition(
      item({ urgency: 'low' }),
      option({ reversibility: 'read_only', blast_radius: 'self', undo_prompt: null }),
      'cold',
      null,
    );
    expect(r.disposition).toBe('silent');
    expect(r.result_delivery).toBe('digest');
    expect(r.tier).toBe(2);
  });

  it('read_only with result_delivery log_only -> tier 1', () => {
    const r = decideDisposition(
      item({ urgency: 'low', result_delivery: 'log_only' }),
      option({ reversibility: 'read_only', blast_radius: 'self', undo_prompt: null }),
      'cold',
      null,
    );
    expect(r.disposition).toBe('silent');
    expect(r.tier).toBe(1);
  });
});

describe('decideDisposition — state-changing silent (step 4) over the grid', () => {
  const grid: Array<{
    blast: BlastRadius;
    rev: Reversibility;
    enough: Band;
    notEnough: Band;
  }> = [
    { blast: 'self', rev: 'reversible', enough: 'warming', notEnough: 'cold' },
    { blast: 'self', rev: 'compensable', enough: 'trusted', notEnough: 'warming' },
    { blast: 'self', rev: 'irreversible', enough: 'trusted', notEnough: 'warming' },
    { blast: 'external', rev: 'reversible', enough: 'trusted', notEnough: 'warming' },
    { blast: 'external', rev: 'compensable', enough: 'trusted', notEnough: 'warming' },
    { blast: 'external', rev: 'irreversible', enough: 'trusted', notEnough: 'warming' },
  ];

  for (const cell of grid) {
    const opt = () =>
      option({
        blast_radius: cell.blast,
        reversibility: cell.rev,
        undo_prompt: cell.rev === 'irreversible' ? null : 'Undo it.',
      });

    it(`${cell.blast}+${cell.rev}: band ${cell.enough} + active rule -> silent`, () => {
      const r = decideDisposition(item(), opt(), cell.enough, silentRule(cell.blast, cell.rev, cell.enough));
      expect(r.disposition).toBe('silent');
      expect(r.rule_id).toBe('r-1');
    });

    it(`${cell.blast}+${cell.rev}: band ${cell.notEnough} (below grid floor) -> review`, () => {
      const r = decideDisposition(item(), opt(), cell.notEnough, silentRule(cell.blast, cell.rev, cell.notEnough));
      expect(r.disposition).toBe('review');
    });

    it(`${cell.blast}+${cell.rev}: band ${cell.enough} but NO active rule -> review`, () => {
      const r = decideDisposition(item(), opt(), cell.enough, null);
      expect(r.disposition).toBe('review');
    });
  }

  it('enforces the grid floor over a too-lenient rule gate (external+reversible needs trusted)', () => {
    // Rule gate says warming is enough, but the grid floor for external+reversible is trusted.
    const r = decideDisposition(
      item(),
      option({ blast_radius: 'external', reversibility: 'reversible' }),
      'warming',
      silentRule('external', 'reversible', 'warming'),
    );
    expect(r.disposition).toBe('review');
  });

  it('a rule whose gate does not permit the option falls through to review', () => {
    // Gate caps blast_radius at self, option is external.
    const p = policy([rule({ gate: gate({ max_blast_radius: 'self' }) })]);
    const r = decideDisposition(
      item(),
      option({ blast_radius: 'external', reversibility: 'reversible' }),
      'trusted',
      p,
    );
    expect(r.disposition).toBe('review');
  });
});

describe('decideDisposition — shadow rules never run silently (step 4)', () => {
  it('shadow rule meeting band+gate -> review with shadow flag and rule_id', () => {
    const r = decideDisposition(
      item(),
      option({ blast_radius: 'self', reversibility: 'reversible' }),
      'warming',
      silentRule('self', 'reversible', 'warming', 'shadow'),
    );
    expect(r.disposition).toBe('review');
    expect(r.shadow).toBe(true);
    expect(r.rule_id).toBe('r-1');
    expect(r.reasons.join(' ')).toContain('shadow');
  });

  it('shadow rule below the band -> plain default review (no would-have)', () => {
    const r = decideDisposition(
      item(),
      option({ blast_radius: 'self', reversibility: 'reversible' }),
      'cold',
      silentRule('self', 'reversible', 'warming', 'shadow'),
    );
    expect(r.disposition).toBe('review');
    expect(r.shadow).toBe(false);
    expect(r.rule_id).toBeNull();
  });
});

describe('decideDisposition — default review (step 5) + requires_monitor', () => {
  it('no covering rule -> review tier 3', () => {
    const r = decideDisposition(item(), option(), 'cold', null);
    expect(r.disposition).toBe('review');
    expect(r.tier).toBe(3);
    expect(r.reasons.join(' ')).toContain('review');
  });

  it('cold + external -> requires_monitor', () => {
    const r = decideDisposition(item(), option({ blast_radius: 'external' }), 'cold', null);
    expect(r.requires_monitor).toBe(true);
  });

  it('cold + irreversible -> requires_monitor', () => {
    const r = decideDisposition(
      item(),
      option({ blast_radius: 'self', reversibility: 'irreversible', undo_prompt: null }),
      'cold',
      null,
    );
    expect(r.requires_monitor).toBe(true);
  });

  it('cold + self + reversible -> no monitor (neither external nor irreversible)', () => {
    const r = decideDisposition(item(), option({ blast_radius: 'self', reversibility: 'reversible' }), 'cold', null);
    expect(r.requires_monitor).toBe(false);
  });

  it('trusted + external (no rule) -> review without monitor (band already trusted)', () => {
    const r = decideDisposition(item(), option({ blast_radius: 'external' }), 'trusted', null);
    expect(r.disposition).toBe('review');
    expect(r.requires_monitor).toBe(false);
  });
});
