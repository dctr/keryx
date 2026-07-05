// Fast-path dispatch: given a parsed comment body with a known `schema` field,
// return the single validator that matches. Falls back to null when schema is
// absent or unrecognised — callers must run the full scan in that case.
//
// This avoids running up to 5 AJV validators per comment in the read-side
// aggregators (metrics.ts, trackRecord.ts). Only schemas that those aggregators
// actually inspect are listed here.

import type { ValidationResult } from './validate';
import { validateCorrection } from './correction';
import { validateDismissalDecision } from './dismissalDecision';
import { validateExecutionDecision } from './executionDecision';
import { validateOutcome } from './outcome';
import { validatePolicyDecision } from './policyDecision';
import { validateRegret } from './regret';

type AnyValidator = (body: unknown) => ValidationResult<unknown>;

const VALIDATOR_MAP: Record<string, AnyValidator> = {
  'keryx.correction.v1': validateCorrection,
  'keryx.dismissal_decision.v1': validateDismissalDecision,
  'keryx.execution_decision.v1': validateExecutionDecision,
  'keryx.outcome.v1': validateOutcome,
  'keryx.policy_decision.v1': validatePolicyDecision,
  'keryx.regret.v1': validateRegret,
};

/**
 * Return the single validator for the given body's `schema` field, or null
 * when the schema field is absent/unrecognised (caller should fall back to
 * the full sequential scan).
 */
export function validatorForSchema(body: unknown): AnyValidator | null {
  if (
    body === null ||
    typeof body !== 'object' ||
    !('schema' in body) ||
    typeof (body as Record<string, unknown>)['schema'] !== 'string'
  ) {
    return null;
  }
  const key = (body as Record<string, unknown>)['schema'] as string;
  return VALIDATOR_MAP[key] ?? null;
}
