import policyDecisionSchema from '../../schemas/policy-decision.v1.schema.json';

import { createValidator } from './validate';

export type Disposition = 'silent' | 'review' | 'interrupt';

export interface PolicyDecision {
  schema: 'keryx.policy_decision.v1';
  selected_option_id: string;
  disposition: Disposition;
  rule_id: string | null;
  reasons: string[];
  approved_by: 'keryx-policy';
  approved_via: string;
  approved_at: string;
}

export { policyDecisionSchema };
export const validatePolicyDecision = createValidator<PolicyDecision>(policyDecisionSchema);
