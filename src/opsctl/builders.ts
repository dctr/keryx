// Shared decision-object builders used across command-group files.
// Each function takes explicit actor fields so callers (human UI vs. automated resolver)
// can supply their own approved_by / approved_via without duplicating the schema shape.

import type { ActionItem, ActionOption } from '../schemas/actionItem';
import type { CorrectionKind } from '../schemas/correction';
import type { PolicyDecision } from '../schemas/policyDecision';

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

// ---------------------------------------------------------------------------
// Correction feedback (keryx.correction.v1)
// ---------------------------------------------------------------------------

export interface BuildCorrectionParams {
  actionItem: ActionItem;
  kind: CorrectionKind;
  note: string;
  recordedBy: string;
  recordedVia: string;
  now: () => Date;
}

export function buildCorrection(params: BuildCorrectionParams) {
  return {
    schema: 'keryx.correction.v1',
    collector: params.actionItem.collector,
    class: params.actionItem.class,
    external_id: params.actionItem.external_id,
    idempotency_key: params.actionItem.idempotency_key,
    kind: params.kind,
    note: params.note,
    recorded_by: params.recordedBy,
    recorded_via: params.recordedVia,
    recorded_at: params.now().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Policy decision (keryx.policy_decision.v1)
// ---------------------------------------------------------------------------

export interface BuildPolicyDecisionParams {
  selected: ActionOption;
  ruleId: string | null;
  reasons: string[];
  now: () => Date;
  /** When true, emits a shadow-mode "would have" record: disposition=review and
   *  approved_via includes 'shadow' so the card stays in review while the intent
   *  to authorize is recorded. */
  shadow: boolean;
}

export function buildPolicyDecision(params: BuildPolicyDecisionParams): PolicyDecision {
  const { selected, ruleId, reasons, now, shadow } = params;
  const disposition = shadow ? 'review' : 'silent';
  const approved_via = shadow
    ? ruleId
      ? `policy:shadow:${ruleId}`
      : 'policy:shadow'
    : ruleId
      ? `policy:${ruleId}`
      : 'policy:read-only';
  return {
    schema: 'keryx.policy_decision.v1',
    selected_option_id: selected.id,
    disposition,
    rule_id: ruleId,
    reasons,
    approved_by: 'keryx-policy',
    approved_via,
    approved_at: now().toISOString(),
  };
}
