import { describe, expect, it } from 'vitest';

import { validateActionItem } from '../../src/schemas/actionItem';

const base = {
  schema: 'keryx.action_item.v2',
  source: 'email',
  collector: 'keryx-email',
  class: 'email:newsletter-unsubscribe',
  external_id: 'inbox:42',
  idempotency_key: 'keryx:email:inbox:42',
  origin_descriptor: 'Inbox — item 42',
  title: 'Handle item 42',
  summary: 'Compact facts only.',
  urgency: 'normal',
  source_refs: [{ type: 'email', uid: '42' }],
  options: [
    {
      id: 'o1',
      label: 'Do it',
      requires_input: false,
      input_hint: null,
      delivery: null,
      reversibility: 'reversible',
      blast_radius: 'self',
      undo_prompt: 'Undo it.',
      execution_prompt: 'Do the thing.',
    },
  ],
  created_at: '2026-06-25T00:00:00+10:00',
};

describe('action_item.v2 validation', () => {
  it('accepts a valid reversible+self card', () => {
    expect(validateActionItem(base).ok).toBe(true);
  });

  it('rejects read_only with blast_radius=external', () => {
    const card = {
      ...base,
      options: [{ ...base.options[0], reversibility: 'read_only', blast_radius: 'external', undo_prompt: null }],
    };
    const r = validateActionItem(card);
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r).includes('read_only')).toBe(true);
  });

  it('rejects read_only carrying an absolute_floor value', () => {
    const card = {
      ...base,
      options: [
        { ...base.options[0], reversibility: 'read_only', blast_radius: 'self', undo_prompt: null, absolute_floor: ['money'] },
      ],
    };
    expect(validateActionItem(card).ok).toBe(false);
  });

  it('requires undo_prompt for reversible/compensable and forbids it for read_only/irreversible', () => {
    const reversibleNoUndo = { ...base, options: [{ ...base.options[0], undo_prompt: null }] };
    expect(validateActionItem(reversibleNoUndo).ok).toBe(false);
    const readOnly = { ...base, options: [{ ...base.options[0], reversibility: 'read_only', undo_prompt: null }] };
    expect(validateActionItem(readOnly).ok).toBe(true);
  });

  it('requires default_on_timeout with a real option_id when proposed_disposition=interrupt', () => {
    const noTimeout = { ...base, proposed_disposition: 'interrupt' };
    expect(validateActionItem(noTimeout).ok).toBe(false);
    const badRef = { ...base, proposed_disposition: 'interrupt', default_on_timeout: { action: 'execute_option', option_id: 'missing', after: 'PT2H' } };
    expect(validateActionItem(badRef).ok).toBe(false);
    const good = { ...base, proposed_disposition: 'interrupt', default_on_timeout: { action: 'execute_option', option_id: 'o1', after: 'PT2H' } };
    expect(validateActionItem(good).ok).toBe(true);
  });

  it('rejects the legacy autonomy field via additionalProperties', () => {
    const legacy = { ...base, autonomy: 'auto' };
    expect(validateActionItem(legacy).ok).toBe(false);
  });

  it('requires a class field', () => {
    const noClass = { ...base } as Record<string, unknown>;
    delete noClass.class;
    expect(validateActionItem(noClass).ok).toBe(false);
  });
});
