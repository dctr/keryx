/**
 * API wire-contract types shared between the Fastify server (Node) and the Vite web bundle (browser).
 * CRITICAL: no runtime Node.js imports — this file must be importable in both environments.
 */

import type { ActionItem } from '../schemas/actionItem';

export type ConfidenceBand = 'cold' | 'warming' | 'trusted';

export interface TaskOutcome {
  result_summary: string;
  result_delivery?: 'digest' | 'push' | 'log_only';
  changed_state?: string | null;
}

export interface ApiTask {
  id: string;
  title: string | null;
  status: string;
  source: string;
  tenant: string | null;
  created_by: string | null;
  action_item: ActionItem;
  confidence_band?: ConfidenceBand | null;
  outcome?: TaskOutcome | null;
}

export interface MalformedTaskError {
  task_id: string;
  title: string | null;
  status: string;
  error: string;
}

export interface SourceStatus {
  id?: string;
  name: string;
  source: string;
  status: 'OK' | 'FAILED' | 'PAUSED' | 'STALE' | 'MISSING' | 'UNKNOWN';
  enabled: boolean;
  schedule?: string;
  last_status?: string;
  last_run_at?: string;
  last_success_at?: string;
  last_error?: string;
  last_delivery_error?: string;
  next_run_at?: string;
  state?: string;
}
