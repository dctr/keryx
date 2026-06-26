import actionItemSchema from '../../schemas/action-item.v2.schema.json';

import { type ValidationError, createValidator } from './validate';

export type Reversibility = 'read_only' | 'reversible' | 'compensable' | 'irreversible';
export type BlastRadius = 'self' | 'external';
export type Urgency = 'low' | 'normal' | 'soon' | 'urgent';
export type Effort = 'minimal' | 'research' | 'complex';
export type Disposition = 'silent' | 'review' | 'interrupt';
export type ResultDelivery = 'digest' | 'push' | 'log_only';
export type AbsoluteFloor = 'money' | 'destructive' | 'credential_gate';

export interface SourceRef {
  type: string;
  [key: string]: string | number | boolean | null;
}

export interface ActionOption {
  id: string;
  label: string;
  requires_input: boolean;
  input_hint?: string | null;
  delivery?: string | null;
  reversibility: Reversibility;
  blast_radius: BlastRadius;
  undo_prompt?: string | null;
  absolute_floor?: AbsoluteFloor[];
  execution_prompt: string;
}

export interface DefaultOnTimeout {
  action: 'execute_option' | 'dismiss';
  option_id?: string;
  after: string;
}

export interface ActionItemUiHints {
  primary_option_id?: string;
  display_group?: string;
}

export interface ActionItem {
  schema: 'keryx.action_item.v2';
  source: string;
  collector: string;
  class: string;
  external_id: string;
  idempotency_key: string;
  origin_descriptor: string;
  title: string;
  summary: string;
  effort?: Effort;
  urgency: Urgency;
  proposed_disposition?: Disposition;
  result_delivery?: ResultDelivery;
  digest_cadence?: 'daily' | 'weekly';
  digest_category?: string;
  deadline?: string | null;
  risk?: string | null;
  default_on_timeout?: DefaultOnTimeout | null;
  source_refs: SourceRef[];
  options: ActionOption[];
  ui?: ActionItemUiHints;
  created_at: string;
}

export { actionItemSchema };

function optionsOf(value: unknown): Array<Record<string, unknown>> {
  const opts = (value as { options?: unknown }).options;
  return Array.isArray(opts) ? opts.filter((o): o is Record<string, unknown> => typeof o === 'object' && o !== null) : [];
}

// draft-07 cannot express "ui.primary_option_id must be one of options[].id", so the
// referential check lives here. It runs even when Ajv has already failed, so a present
// primary_option_id that matches no option id always surfaces as /ui/primary_option_id.
function crossValidatePrimaryOptionId(value: unknown): ValidationError[] {
  if (typeof value !== 'object' || value === null) {
    return [];
  }

  const ui = (value as { ui?: { primary_option_id?: unknown } }).ui;
  const primary = ui?.primary_option_id;
  if (typeof primary !== 'string') {
    return [];
  }

  const optionIds = optionsOf(value)
    .map((option) => option.id)
    .filter((id): id is string => typeof id === 'string');

  return optionIds.includes(primary)
    ? []
    : [
        {
          path: '/ui/primary_option_id',
          message: 'must reference one of the defined option ids',
          keyword: 'cross-validation',
          params: { primaryOptionId: primary, optionIds },
        },
      ];
}

// read_only options must be self-scoped and carry no absolute_floor value: a read-only
// plan changes nothing and therefore cannot reach an external blast radius or trip a
// money/destructive/credential floor. Enforced here because draft-07 cannot key one
// property's constraints off another's enum value.
function crossValidateReadOnly(value: unknown): ValidationError[] {
  if (typeof value !== 'object' || value === null) {
    return [];
  }

  const errors: ValidationError[] = [];
  optionsOf(value).forEach((option, index) => {
    if (option.reversibility !== 'read_only') {
      return;
    }
    if (option.blast_radius !== 'self') {
      errors.push({
        path: `/options/${index}/blast_radius`,
        message: 'read_only requires blast_radius=self',
        keyword: 'cross-validation',
        params: {},
      });
    }
    if (Array.isArray(option.absolute_floor) && option.absolute_floor.length > 0) {
      errors.push({
        path: `/options/${index}/absolute_floor`,
        message: 'read_only must not carry an absolute_floor value',
        keyword: 'cross-validation',
        params: {},
      });
    }
  });
  return errors;
}

// undo_prompt is required exactly when an option is reversible or compensable (it tells
// the worker how to roll back), and must be absent for read_only/irreversible options
// (nothing to undo, or no honest undo exists).
function crossValidateUndoPrompt(value: unknown): ValidationError[] {
  if (typeof value !== 'object' || value === null) {
    return [];
  }

  const errors: ValidationError[] = [];
  optionsOf(value).forEach((option, index) => {
    const reversibility = option.reversibility;
    const hasUndo = typeof option.undo_prompt === 'string' && option.undo_prompt.length > 0;
    if ((reversibility === 'reversible' || reversibility === 'compensable') && !hasUndo) {
      errors.push({
        path: `/options/${index}/undo_prompt`,
        message: 'undo_prompt required for reversible/compensable options',
        keyword: 'cross-validation',
        params: {},
      });
    }
    if ((reversibility === 'read_only' || reversibility === 'irreversible') && hasUndo) {
      errors.push({
        path: `/options/${index}/undo_prompt`,
        message: 'undo_prompt must be absent for read_only/irreversible options',
        keyword: 'cross-validation',
        params: {},
      });
    }
  });
  return errors;
}

// An interrupt-proposed card must declare a default_on_timeout so an unanswered
// interrupt resolves deterministically. When that default executes an option, it must
// reference an option that actually exists on the card.
function crossValidateInterruptTimeout(value: unknown): ValidationError[] {
  if (typeof value !== 'object' || value === null) {
    return [];
  }
  if ((value as { proposed_disposition?: unknown }).proposed_disposition !== 'interrupt') {
    return [];
  }

  const timeout = (value as { default_on_timeout?: unknown }).default_on_timeout;
  if (typeof timeout !== 'object' || timeout === null) {
    return [
      {
        path: '/default_on_timeout',
        message: 'required when proposed_disposition=interrupt',
        keyword: 'cross-validation',
        params: {},
      },
    ];
  }

  const action = (timeout as { action?: unknown }).action;
  const optionId = (timeout as { option_id?: unknown }).option_id;
  if (action === 'execute_option') {
    const optionIds = optionsOf(value).map((option) => option.id);
    if (typeof optionId !== 'string' || !optionIds.includes(optionId)) {
      return [
        {
          path: '/default_on_timeout/option_id',
          message: 'must reference a defined option id',
          keyword: 'cross-validation',
          params: {},
        },
      ];
    }
  }
  return [];
}

export const validateActionItem = createValidator<ActionItem>(actionItemSchema, [
  crossValidatePrimaryOptionId,
  crossValidateReadOnly,
  crossValidateUndoPrompt,
  crossValidateInterruptTimeout,
]);
