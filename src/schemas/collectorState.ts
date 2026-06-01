import collectorStateSchema from '../../schemas/collector-state.v1.schema.json';

import { createValidator } from './validate';

export type CollectorCursor = string | number | null;

export interface CollectorState {
  schema: 'keryx.collector_state.v1';
  source: string;
  committed_cursor: CollectorCursor;
  last_success_at: string | null;
  exact_dismissed_external_ids: string[];
  diagnostic_metadata?: Record<string, string | number | boolean | null>;
}

export { collectorStateSchema };
export const validateCollectorState = createValidator<CollectorState>(collectorStateSchema);
