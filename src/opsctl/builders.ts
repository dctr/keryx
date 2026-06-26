// Shared decision-object builders used across command-group files.
// Each function takes explicit actor fields so callers (human UI vs. automated resolver)
// can supply their own approved_by / approved_via without duplicating the schema shape.

import type { ActionItem } from '../schemas/actionItem';

// ---------------------------------------------------------------------------
// Execution decision (keryx.execution_decision.v1)
// ---------------------------------------------------------------------------

export interface BuildExecutionDecisionParams {
  selectedOptionId: string;
  userFeedback: string | null;
  approvedBy: string;
  approvedVia: string;
  now: () => Date;
}

export function buildExecutionDecision(params: BuildExecutionDecisionParams) {
  return {
    schema: 'keryx.execution_decision.v1',
    selected_option_id: params.selectedOptionId,
    user_feedback: params.userFeedback,
    approved_by: params.approvedBy,
    approved_via: params.approvedVia,
    approved_at: params.now().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Dismissal decision (keryx.dismissal_decision.v1)
// ---------------------------------------------------------------------------

export interface BuildDismissalDecisionParams {
  actionItem: ActionItem;
  reason: string | null;
  dismissedBy: string;
  dismissedVia: string;
  now: () => Date;
}

export function buildDismissalDecision(params: BuildDismissalDecisionParams) {
  return {
    schema: 'keryx.dismissal_decision.v1',
    dismissal_scope: 'exact_item',
    reason: params.reason,
    dismissed_external_id: params.actionItem.external_id,
    dismissed_idempotency_key: params.actionItem.idempotency_key,
    dismissed_by: params.dismissedBy,
    dismissed_via: params.dismissedVia,
    dismissed_at: params.now().toISOString(),
  };
}
