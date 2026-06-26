import policySchema from '../../schemas/policy.v1.schema.json';

import { createValidator } from './validate';

export type Band = 'cold' | 'warming' | 'trusted';
export type RuleState = 'shadow' | 'active';

export interface PolicyRuleGate {
  max_blast_radius: 'self' | 'external';
  min_reversibility: 'read_only' | 'reversible' | 'compensable' | 'irreversible';
  min_confidence: Band;
}

export interface PolicyRule {
  id: string;
  class: string;
  gate: PolicyRuleGate;
  disposition: 'silent' | 'review' | 'interrupt';
  result_delivery?: 'digest' | 'push' | 'log_only';
  state: RuleState;
  approved_by: string;
  approved_at: string;
  source_card_id: string | null;
  scope_note: string | null;
}

export interface PolicyTrackRecordEntry {
  approved: number;
  overridden: number;
  dismissed: number;
  regret: number;
  band: Band;
  updated_at: string;
}

export interface PolicyThresholds {
  spend_requires_approval_always: boolean;
}

export interface Policy {
  schema: 'keryx.policy.v1';
  collector: string;
  version: number;
  updated_at: string;
  rules: PolicyRule[];
  thresholds: PolicyThresholds;
  track_record: Record<string, PolicyTrackRecordEntry>;
}

export { policySchema };
export const validatePolicy = createValidator<Policy>(policySchema);
