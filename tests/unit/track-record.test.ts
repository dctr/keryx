import { describe, expect, it } from 'vitest';

import { sampleActionItem } from '../helpers/sampleActionItem';
import { aggregateTrackRecord } from '../../src/policy/trackRecord';
import type { ActionItem } from '../../src/schemas/actionItem';
import type { KanbanComment, KanbanTask } from '../../src/hermes/types';

function cardBody(cls: string, primaryOptionId = 'opt-primary', overrides: Partial<ActionItem> = {}): string {
  const item = sampleActionItem({
    class: cls,
    options: [
      {
        id: primaryOptionId,
        label: 'Primary',
        requires_input: false,
        input_hint: null,
        delivery: null,
        reversibility: 'reversible',
        blast_radius: 'self',
        undo_prompt: 'Undo it.',
        execution_prompt: 'Do the primary thing.',
      },
      {
        id: 'opt-alt',
        label: 'Alternative',
        requires_input: false,
        input_hint: null,
        delivery: null,
        reversibility: 'reversible',
        blast_radius: 'self',
        undo_prompt: 'Undo the alternative.',
        execution_prompt: 'Do the alternative thing.',
      },
    ],
    ui: { primary_option_id: primaryOptionId },
    ...overrides,
  });
  return JSON.stringify(item);
}

function comment(body: unknown): KanbanComment {
  return { body: typeof body === 'string' ? body : JSON.stringify(body) };
}

function executionDecision(selectedOptionId: string): KanbanComment {
  return comment({
    schema: 'keryx.execution_decision.v1',
    selected_option_id: selectedOptionId,
    user_feedback: null,
    approved_by: 'User',
    approved_via: 'ui',
    approved_at: '2026-06-25T09:00:00Z',
  });
}

function dismissal(externalId: string): KanbanComment {
  return comment({
    schema: 'keryx.dismissal_decision.v1',
    dismissal_scope: 'exact_item',
    reason: null,
    dismissed_external_id: externalId,
    dismissed_idempotency_key: `keryx:email:${externalId}`,
    dismissed_by: 'User',
    dismissed_via: 'ui',
    dismissed_at: '2026-06-25T09:00:00Z',
  });
}

function regret(kind: 'should_have_acted' | 'should_have_asked'): KanbanComment {
  return comment({
    schema: 'keryx.regret.v1',
    kind,
    note: null,
    recorded_by: 'User',
    recorded_at: '2026-06-25T09:00:00Z',
  });
}

function task(body: string, comments: KanbanComment[], id = 't1'): KanbanTask {
  return { id, body, comments };
}

const CLASS = 'email:newsletter-unsubscribe';

describe('aggregateTrackRecord', () => {
  it('returns an empty map for no tasks', () => {
    expect(aggregateTrackRecord([])).toEqual({});
  });

  it('counts an approval when the selected option is the primary recommendation', () => {
    const tasks = [task(cardBody(CLASS, 'opt-primary'), [executionDecision('opt-primary')])];
    expect(aggregateTrackRecord(tasks)[CLASS]).toEqual({
      approved: 1,
      overridden: 0,
      dismissed: 0,
      regret: 0,
    });
  });

  it('counts an override (not an approval) when the selected option differs from primary', () => {
    const tasks = [task(cardBody(CLASS, 'opt-primary'), [executionDecision('opt-alt')])];
    expect(aggregateTrackRecord(tasks)[CLASS]).toEqual({
      approved: 0,
      overridden: 1,
      dismissed: 0,
      regret: 0,
    });
  });

  it('counts a dismissal', () => {
    const tasks = [task(cardBody(CLASS), [dismissal('inbox:42')])];
    expect(aggregateTrackRecord(tasks)[CLASS].dismissed).toBe(1);
  });

  it('counts regret comments', () => {
    const tasks = [task(cardBody(CLASS), [regret('should_have_asked')])];
    expect(aggregateTrackRecord(tasks)[CLASS].regret).toBe(1);
  });

  it('tallies multiple comment kinds on a single task', () => {
    const tasks = [
      task(cardBody(CLASS, 'opt-primary'), [
        executionDecision('opt-primary'),
        regret('should_have_acted'),
      ]),
    ];
    expect(aggregateTrackRecord(tasks)[CLASS]).toEqual({
      approved: 1,
      overridden: 0,
      dismissed: 0,
      regret: 1,
    });
  });

  it('aggregates across tasks per class and keeps classes separate', () => {
    const other = 'calendar:reschedule-reply';
    const tasks = [
      task(cardBody(CLASS, 'opt-primary'), [executionDecision('opt-primary')], 'a'),
      task(cardBody(CLASS, 'opt-primary'), [executionDecision('opt-alt')], 'b'),
      task(cardBody(CLASS), [dismissal('inbox:7')], 'c'),
      task(cardBody(other, 'opt-primary'), [executionDecision('opt-primary')], 'd'),
    ];
    const record = aggregateTrackRecord(tasks);
    expect(record[CLASS]).toEqual({ approved: 1, overridden: 1, dismissed: 1, regret: 0 });
    expect(record[other]).toEqual({ approved: 1, overridden: 0, dismissed: 0, regret: 0 });
  });

  it('treats a decision as an approval when the card declares no primary option', () => {
    const item = sampleActionItem({ class: CLASS });
    delete (item as { ui?: unknown }).ui;
    const tasks = [task(JSON.stringify(item), [executionDecision('translate_forward_contact_archive')])];
    expect(aggregateTrackRecord(tasks)[CLASS]).toEqual({
      approved: 1,
      overridden: 0,
      dismissed: 0,
      regret: 0,
    });
  });

  it('skips tasks whose body is not a valid action item (no class to attribute)', () => {
    const tasks = [
      { id: 'bad', body: 'not json', comments: [executionDecision('x')] },
      { id: 'noclass', body: JSON.stringify({ hello: 'world' }), comments: [executionDecision('x')] },
    ];
    expect(aggregateTrackRecord(tasks)).toEqual({});
  });

  it('ignores comments that are not valid keryx machine bodies', () => {
    const tasks = [
      task(cardBody(CLASS), [
        comment('just a human note'),
        comment({ schema: 'keryx.policy_decision.v1' }),
        comment({ schema: 'keryx.execution_decision.v1', selected_option_id: 'opt-primary' }), // missing required fields
      ]),
    ];
    // None of the above validate as a counted comment, so the class still registers at zero.
    expect(aggregateTrackRecord(tasks)[CLASS]).toEqual({
      approved: 0,
      overridden: 0,
      dismissed: 0,
      regret: 0,
    });
  });

  it('registers a class at zero counts even with no comments', () => {
    const tasks = [task(cardBody(CLASS), [])];
    expect(aggregateTrackRecord(tasks)[CLASS]).toEqual({
      approved: 0,
      overridden: 0,
      dismissed: 0,
      regret: 0,
    });
  });
});
