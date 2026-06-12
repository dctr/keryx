import actionItemSchema from '../../schemas/action-item.v1.schema.json';

import { type ValidationError, createValidator } from './validate';

export type Autonomy = 'auto' | 'minimal' | 'research' | 'complex';
export type Urgency = 'low' | 'normal' | 'soon' | 'urgent';

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
  execution_prompt: string;
}

export interface ActionItemUiHints {
  primary_option_id?: string;
  display_group?: string;
}

export interface ActionItem {
  schema: 'keryx.action_item.v1';
  source: string;
  collector: string;
  external_id: string;
  idempotency_key: string;
  origin_descriptor: string;
  title: string;
  summary: string;
  autonomy: Autonomy;
  urgency: Urgency;
  deadline?: string | null;
  risk?: string | null;
  source_refs: SourceRef[];
  options: ActionOption[];
  ui?: ActionItemUiHints;
  created_at: string;
}

export { actionItemSchema };

// draft-07 cannot express "ui.primary_option_id must be one of options[].id", so the
// referential check lives here. It runs even when Ajv has already failed, so a present
// primary_option_id that matches no option id always surfaces as /ui/primary_option_id.
function crossValidatePrimaryOptionId(value: unknown): ValidationError[] {
  if (typeof value !== 'object' || value === null) {
    return [];
  }

  const ui = (value as { ui?: unknown }).ui;
  if (typeof ui !== 'object' || ui === null) {
    return [];
  }

  const primaryOptionId = (ui as { primary_option_id?: unknown }).primary_option_id;
  if (typeof primaryOptionId !== 'string') {
    return [];
  }

  const options = (value as { options?: unknown }).options;
  const optionIds = Array.isArray(options)
    ? options
        .map((option) => (typeof option === 'object' && option !== null ? (option as { id?: unknown }).id : undefined))
        .filter((id): id is string => typeof id === 'string')
    : [];

  if (optionIds.includes(primaryOptionId)) {
    return [];
  }

  return [
    {
      path: '/ui/primary_option_id',
      message: 'must reference one of the defined option ids',
      keyword: 'cross-validation',
      params: { primaryOptionId, optionIds },
    },
  ];
}

export const validateActionItem = createValidator<ActionItem>(actionItemSchema, [crossValidatePrimaryOptionId]);
