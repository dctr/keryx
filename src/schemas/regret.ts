import regretSchema from '../../schemas/regret.v1.schema.json';

import { createValidator } from './validate';

export interface Regret {
  schema: 'keryx.regret.v1';
  kind: 'should_have_acted' | 'should_have_asked';
  note: string | null;
  recorded_by: string;
  recorded_at: string;
}

export { regretSchema };
export const validateRegret = createValidator<Regret>(regretSchema);
