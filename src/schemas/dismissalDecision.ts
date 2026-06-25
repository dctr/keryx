import dismissalDecisionSchema from '../../schemas/dismissal-decision.v1.schema.json';

import { createValidator } from './validate';

export interface DismissalDecision {
  schema: 'keryx.dismissal_decision.v1';
  dismissal_scope: 'exact_item';
  reason: string | null;
  dismissed_external_id: string;
  dismissed_idempotency_key: string;
  dismissed_by: string;
  dismissed_via: string;
  dismissed_at: string;
}

export { dismissalDecisionSchema };
export const validateDismissalDecision = createValidator<DismissalDecision>(dismissalDecisionSchema);
