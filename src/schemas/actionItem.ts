import actionItemSchema from '../../schemas/action-item.v1.schema.json';

import { createValidator } from './validate';

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
export const validateActionItem = createValidator<ActionItem>(actionItemSchema);
