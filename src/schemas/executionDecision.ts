import executionDecisionSchema from '../../schemas/execution-decision.v1.schema.json';

import { createValidator } from './validate';

export interface ExecutionDecision {
  schema: 'keryx.execution_decision.v1';
  selected_option_id: string;
  user_feedback: string | null;
  approved_by: string;
  approved_via: string;
  approved_at: string;
}

export { executionDecisionSchema };
export const validateExecutionDecision = createValidator<ExecutionDecision>(executionDecisionSchema);
