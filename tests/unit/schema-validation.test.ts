import { describe, expect, it } from 'vitest';

import { validateActionItem } from '../../src/schemas/actionItem';
import { validateCollectorState } from '../../src/schemas/collectorState';
import { validateExecutionDecision } from '../../src/schemas/executionDecision';
import type { ActionItem } from '../../src/schemas/actionItem';
import type { CollectorState } from '../../src/schemas/collectorState';
import type { ExecutionDecision } from '../../src/schemas/executionDecision';

const validActionItem: ActionItem = {
  schema: 'keryx.action_item.v1',
  source: 'email',
  collector: 'keryx-email',
  external_id: 'support-inbox:INBOX:35680',
  idempotency_key: 'keryx:email:support-inbox:INBOX:35680',
  origin_descriptor: 'Support Desk — Account access request',
  title: 'Support request: account access needs review',
  summary: 'Customer reports that account access is failing after a recent change.',
  autonomy: 'auto',
  urgency: 'normal',
  deadline: null,
  risk: 'Support request may stall if ignored.',
  source_refs: [
    {
      type: 'email',
      account: 'support-inbox',
      folder: 'INBOX',
      uid: '35680',
    },
  ],
  options: [
    {
      id: 'translate_forward_contact_archive',
      label: 'Translate + forward to support contact + archive email',
      requires_input: false,
      input_hint: null,
      delivery: null,
      execution_prompt:
        "Translate the support request into the target language, forward it to the configured support contact, then archive the source email.",
    },
  ],
  ui: {
    primary_option_id: 'translate_forward_contact_archive',
    display_group: 'Needs approval',
  },
  created_at: '2026-05-31T00:00:00+10:00',
};

const validExecutionDecision: ExecutionDecision = {
  schema: 'keryx.execution_decision.v1',
  selected_option_id: 'translate_forward_contact_archive',
  user_feedback: 'Prefer a concise note.',
  approved_by: 'User',
  approved_via: 'keryx-web',
  approved_at: '2026-05-31T00:00:00+10:00',
};

const validCollectorState: CollectorState = {
  schema: 'keryx.collector_state.v1',
  source: 'email',
  committed_cursor: '35680',
  last_success_at: '2026-05-31T00:00:00+10:00',
  exact_dismissed_external_ids: [],
};

describe('Keryx schema validation', () => {
  it('accepts a valid PRD-style action item', () => {
    const result = validateActionItem(validActionItem);

    expect(result).toEqual({ ok: true, value: validActionItem });
  });

  it('returns a useful error when a required action item field is missing', () => {
    const malformed = { ...validActionItem } as Record<string, unknown>;
    delete malformed.title;

    const result = validateActionItem(malformed);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: '', message: expect.stringContaining("must have required property 'title'") }),
        ]),
      );
    }
  });

  it('rejects an invalid autonomy value with a useful path', () => {
    const result = validateActionItem({ ...validActionItem, autonomy: 'reckless' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: '/autonomy', message: expect.stringContaining('must be equal to one of the allowed values') }),
        ]),
      );
    }
  });

  it('rejects an option without an execution prompt', () => {
    const option = { ...validActionItem.options[0] } as Record<string, unknown>;
    delete option.execution_prompt;

    const result = validateActionItem({ ...validActionItem, options: [option] });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: '/options/0', message: expect.stringContaining("must have required property 'execution_prompt'") }),
        ]),
      );
    }
  });

  it('accepts a valid execution decision comment', () => {
    const result = validateExecutionDecision(validExecutionDecision);

    expect(result).toEqual({ ok: true, value: validExecutionDecision });
  });

  it('accepts valid collector state without raw source content', () => {
    const result = validateCollectorState(validCollectorState);

    expect(result).toEqual({ ok: true, value: validCollectorState });
  });
});
