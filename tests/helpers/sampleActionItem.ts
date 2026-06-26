import type { ActionItem, ActionOption } from '../../src/schemas/actionItem';

// Shared builder for a schema-valid keryx.action_item.v2 card. Tests spread overrides
// over this base so the v2 contract (class + per-option risk axes) lives in one place.
const baseActionItem: ActionItem = {
  schema: 'keryx.action_item.v2',
  source: 'email',
  collector: 'keryx-email',
  class: 'email:support-request',
  external_id: 'support-inbox:INBOX:35680',
  idempotency_key: 'keryx:email:support-inbox:INBOX:35680',
  origin_descriptor: 'Support Desk — Account access request',
  title: 'Support request: account access needs review',
  summary: 'Customer reports that account access is failing after a recent change.',
  urgency: 'normal',
  proposed_disposition: 'review',
  deadline: null,
  risk: 'Support request may stall if ignored.',
  source_refs: [{ type: 'email', account: 'support-inbox', folder: 'INBOX', uid: '35680' }],
  options: [
    {
      id: 'translate_forward_contact_archive',
      label: 'Translate + forward to support contact + archive email',
      requires_input: false,
      input_hint: null,
      delivery: null,
      reversibility: 'reversible',
      blast_radius: 'external',
      undo_prompt: 'Restore the archived email and notify the support contact the forward was sent in error.',
      execution_prompt:
        'Translate the support request into the target language, forward it to the configured support contact, then archive the source email.',
    },
  ],
  ui: { primary_option_id: 'translate_forward_contact_archive', display_group: 'Needs approval' },
  created_at: '2026-05-31T00:00:00+10:00',
};

export function sampleActionItem(overrides: Partial<ActionItem> = {}): ActionItem {
  return { ...structuredClone(baseActionItem), ...overrides };
}

export function sampleActionOption(overrides: Partial<ActionOption> = {}): ActionOption {
  return { ...structuredClone(baseActionItem.options[0]), ...overrides };
}
