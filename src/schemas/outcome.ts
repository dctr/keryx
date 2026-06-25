import outcomeSchema from '../../schemas/outcome.v1.schema.json';

import { createValidator } from './validate';

export type ResultDelivery = 'digest' | 'push' | 'log_only';

export interface Outcome {
  schema: 'keryx.outcome.v1';
  executed_option_id: string;
  result_summary: string;
  result_delivery: ResultDelivery;
  digest_category: string | null;
  digest_cadence?: 'daily' | 'weekly';
  changed_state: string | null;
  delivered_via: string | null;
  digested?: boolean;
  completed_at: string;
}

export { outcomeSchema };
export const validateOutcome = createValidator<Outcome>(outcomeSchema);
