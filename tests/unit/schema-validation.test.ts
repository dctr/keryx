import { describe, expect, it } from 'vitest';

import { validateActionItem } from '../../src/schemas/actionItem';
import { validateCollectorState } from '../../src/schemas/collectorState';
import { validateDismissalDecision } from '../../src/schemas/dismissalDecision';
import { validateExecutionDecision } from '../../src/schemas/executionDecision';
import { validateNotification } from '../../src/schemas/notification';
import { validateOutcome } from '../../src/schemas/outcome';
import { validatePolicyDecision } from '../../src/schemas/policyDecision';
import { validateRegret } from '../../src/schemas/regret';
import type { ActionItem } from '../../src/schemas/actionItem';
import type { CollectorState } from '../../src/schemas/collectorState';
import type { DismissalDecision } from '../../src/schemas/dismissalDecision';
import type { ExecutionDecision } from '../../src/schemas/executionDecision';
import type { Notification } from '../../src/schemas/notification';
import type { Outcome } from '../../src/schemas/outcome';
import type { PolicyDecision } from '../../src/schemas/policyDecision';
import type { Regret } from '../../src/schemas/regret';

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

  it('accepts the documented keryx:<source>:<id> idempotency key shape', () => {
    const result = validateActionItem({ ...validActionItem, idempotency_key: 'keryx:email:support-inbox:INBOX:35680' });

    expect(result.ok).toBe(true);
  });

  it('rejects a single-segment idempotency key with a useful path', () => {
    const result = validateActionItem({ ...validActionItem, idempotency_key: 'keryx:onlyone' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toEqual(
        expect.arrayContaining([expect.objectContaining({ path: '/idempotency_key', keyword: 'pattern' })]),
      );
    }
  });

  it('rejects an idempotency key with an empty trailing segment', () => {
    const result = validateActionItem({ ...validActionItem, idempotency_key: 'keryx:email:' });

    expect(result.ok).toBe(false);
  });

  it('cross-validates a present ui.primary_option_id against options[].id', () => {
    const result = validateActionItem({ ...validActionItem, ui: { primary_option_id: 'does_not_exist' } });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: '/ui/primary_option_id', message: expect.stringContaining('option id') }),
        ]),
      );
    }
  });

  it('reports a primary_option_id mismatch alongside Ajv errors', () => {
    const malformed = { ...validActionItem, ui: { primary_option_id: 'does_not_exist' } } as Record<string, unknown>;
    delete malformed.title;

    const result = validateActionItem(malformed);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      const paths = result.errors.map((error) => error.path);
      expect(paths).toContain('/ui/primary_option_id');
      expect(result.errors.some((error) => error.message.includes("must have required property 'title'"))).toBe(true);
    }
  });

  it('accepts an action item without ui hints', () => {
    const withoutUi = { ...validActionItem } as Record<string, unknown>;
    delete withoutUi.ui;

    expect(validateActionItem(withoutUi).ok).toBe(true);
  });

  it('accepts ui hints that omit primary_option_id', () => {
    const result = validateActionItem({ ...validActionItem, ui: { display_group: 'Needs approval' } });

    expect(result.ok).toBe(true);
  });

  it('accepts a valid execution decision comment', () => {
    const result = validateExecutionDecision(validExecutionDecision);

    expect(result).toEqual({ ok: true, value: validExecutionDecision });
  });

  it('accepts valid collector state without raw source content', () => {
    const result = validateCollectorState(validCollectorState);

    expect(result).toEqual({ ok: true, value: validCollectorState });
  });

  it('accepts collector state carrying executed_external_ids and keeps the field optional', () => {
    const withExecuted: CollectorState = { ...validCollectorState, executed_external_ids: ['support-inbox:INBOX:35680'] };
    expect(validateCollectorState(withExecuted).ok).toBe(true);
    expect(validateCollectorState(validCollectorState).ok).toBe(true);
  });

  it('rejects collector state with duplicate executed_external_ids', () => {
    const duplicated = { ...validCollectorState, executed_external_ids: ['a', 'a'] };
    expect(validateCollectorState(duplicated).ok).toBe(false);
  });
});

const validDismissalDecision: DismissalDecision = {
  schema: 'keryx.dismissal_decision.v1',
  dismissal_scope: 'exact_item',
  reason: 'No longer relevant',
  dismissed_external_id: 'support-inbox:INBOX:35680',
  dismissed_idempotency_key: 'keryx:email:support-inbox:INBOX:35680',
  dismissed_by: 'User',
  dismissed_via: 'keryx-web',
  dismissed_at: '2026-05-31T12:34:56.000Z',
};

describe('dismissal-decision.v1 validation', () => {
  it('accepts a known-good dismissal body', () => {
    expect(validateDismissalDecision(validDismissalDecision)).toEqual({ ok: true, value: validDismissalDecision });
  });

  it('accepts a null reason', () => {
    expect(validateDismissalDecision({ ...validDismissalDecision, reason: null }).ok).toBe(true);
  });

  it('rejects a body missing dismissed_idempotency_key', () => {
    const malformed = { ...validDismissalDecision } as Record<string, unknown>;
    delete malformed.dismissed_idempotency_key;
    expect(validateDismissalDecision(malformed).ok).toBe(false);
  });

  it('rejects a non-exact dismissal scope', () => {
    expect(validateDismissalDecision({ ...validDismissalDecision, dismissal_scope: 'fuzzy' }).ok).toBe(false);
  });
});

const validPolicyDecision: PolicyDecision = {
  schema: 'keryx.policy_decision.v1',
  selected_option_id: 'translate_forward_contact_archive',
  disposition: 'silent',
  rule_id: null,
  reasons: ['read_only -> silent by design'],
  approved_by: 'keryx-policy',
  approved_via: 'policy:read-only',
  approved_at: '2026-05-31T12:34:56.000Z',
};

describe('policy-decision.v1 validation', () => {
  it('accepts a synthetic read-only policy decision', () => {
    expect(validatePolicyDecision(validPolicyDecision)).toEqual({ ok: true, value: validPolicyDecision });
  });

  it('accepts a rule-backed silent decision', () => {
    const ruleBacked = { ...validPolicyDecision, rule_id: 'rule-1', approved_via: 'policy:rule-1' };
    expect(validatePolicyDecision(ruleBacked).ok).toBe(true);
  });

  it('rejects a human approver (policy decisions are non-human only)', () => {
    expect(validatePolicyDecision({ ...validPolicyDecision, approved_by: 'User' }).ok).toBe(false);
  });

  it('rejects an empty reasons array', () => {
    expect(validatePolicyDecision({ ...validPolicyDecision, reasons: [] }).ok).toBe(false);
  });
});

const validOutcome: Outcome = {
  schema: 'keryx.outcome.v1',
  executed_option_id: 'translate_forward_contact_archive',
  result_summary: 'Unsubscribed from the newsletter.',
  result_delivery: 'digest',
  digest_category: 'email cleanup',
  changed_state: 'Removed one subscription.',
  delivered_via: null,
  completed_at: '2026-05-31T12:34:56.000Z',
};

describe('outcome.v1 validation', () => {
  it('accepts a compact silent-execution outcome', () => {
    expect(validateOutcome(validOutcome)).toEqual({ ok: true, value: validOutcome });
  });

  it('accepts an outcome with optional cadence and digested flag', () => {
    const withOptional: Outcome = { ...validOutcome, digest_cadence: 'daily', digested: true };
    expect(validateOutcome(withOptional).ok).toBe(true);
  });

  it('rejects an unknown result_delivery', () => {
    expect(validateOutcome({ ...validOutcome, result_delivery: 'email' }).ok).toBe(false);
  });

  it('rejects an outcome missing result_summary', () => {
    const malformed = { ...validOutcome } as Record<string, unknown>;
    delete malformed.result_summary;
    expect(validateOutcome(malformed).ok).toBe(false);
  });
});

const validNotification: Notification = {
  schema: 'keryx.notification.v1',
  channel: 'interrupt',
  target: 'telegram:293041098',
  sent_at: '2026-05-31T12:34:56.000Z',
  dedupe_key: 'keryx:interrupt:t_email',
};

describe('notification.v1 validation', () => {
  it('accepts a known-good interrupt notification', () => {
    expect(validateNotification(validNotification)).toEqual({ ok: true, value: validNotification });
  });

  it('accepts a digest notification', () => {
    expect(validateNotification({ ...validNotification, channel: 'digest' }).ok).toBe(true);
  });

  it('rejects an unknown channel', () => {
    expect(validateNotification({ ...validNotification, channel: 'push' }).ok).toBe(false);
  });
});

const validRegret: Regret = {
  schema: 'keryx.regret.v1',
  kind: 'should_have_asked',
  note: 'Acted silently when a review was warranted.',
  recorded_by: 'User',
  recorded_at: '2026-05-31T12:34:56.000Z',
};

describe('regret.v1 validation', () => {
  it('accepts a known-good regret signal', () => {
    expect(validateRegret(validRegret)).toEqual({ ok: true, value: validRegret });
  });

  it('accepts a null note', () => {
    expect(validateRegret({ ...validRegret, note: null }).ok).toBe(true);
  });

  it('rejects an unknown regret kind', () => {
    expect(validateRegret({ ...validRegret, kind: 'mild_annoyance' }).ok).toBe(false);
  });
});
