import correctionSchema from '../../schemas/correction.v1.schema.json';

import { createValidator } from './validate';

export type CorrectionKind =
  | 'approval_feedback'
  | 'rejection_feedback'
  | 'silent_regret_feedback'
  | 'policy_rejection_feedback';

export interface Correction {
  schema: 'keryx.correction.v1';
  collector: string;
  class: string;
  external_id: string;
  idempotency_key: string;
  kind: CorrectionKind;
  note: string;
  recorded_by: string;
  recorded_via: string;
  recorded_at: string;
}

export { correctionSchema };
export const validateCorrection = createValidator<Correction>(correctionSchema);