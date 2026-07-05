import type { ApiTask, ConfidenceBand, MalformedTaskError, SourceStatus, TaskOutcome } from '../../shared/apiContract';

export type { ApiTask, ConfidenceBand, MalformedTaskError, SourceStatus, TaskOutcome };

export interface TasksResponse {
  ok: true;
  tasks: ApiTask[];
  errors: MalformedTaskError[];
}

export interface SourcesResponse {
  ok: true;
  sources: SourceStatus[];
}

export interface TaskMutationResponse {
  ok: true;
  task_id: string;
  status?: string;
  action?: string;
}

export type RuleState = 'shadow' | 'active';

export interface PolicyRuleView {
  id: string;
  class: string;
  gate: { max_blast_radius: 'self' | 'external'; min_reversibility: string; min_confidence: ConfidenceBand };
  disposition: 'silent' | 'review' | 'interrupt';
  result_delivery?: 'digest' | 'push' | 'log_only';
  state: RuleState;
  approved_by: string;
  approved_at: string;
  source_card_id: string | null;
  scope_note: string | null;
}

export interface PolicyTrackRecordView {
  approved: number;
  overridden: number;
  approved_since_reset: number;
  overridden_since_reset: number;
  dismissed: number;
  regret: number;
  latest_reset: {
    kind: 'dismissal' | 'regret';
    at: string | null;
  } | null;
  band: ConfidenceBand;
}

export interface PolicyResponse {
  collector: string;
  exists: boolean;
  version: number;
  rules: PolicyRuleView[];
  track_record: Record<string, PolicyTrackRecordView>;
}

export interface PolicyScanResponse {
  ok: true;
  output: string;
}

export interface MetricsResponse {
  window: { from: string | null; to: string | null };
  counts: {
    tasks: number;
    silentExecutions: number;
    shadowWouldHave: number;
    humanApprovals: number;
    overrides: number;
    dismissals: number;
    regrets: number;
    outcomes: number;
    interrupts: number;
  };
  overrideRate: number | null;
  shadowAgreementRate: number | null;
  autonomousSafeCompletionRate: number | null;
  silentFailureCount: number;
  recoveryCost: number;
  escalationRegret: { should_have_acted: number; should_have_asked: number };
}

export type RegretKind = 'should_have_acted' | 'should_have_asked';

export async function fetchTasks(): Promise<TasksResponse> {
  return requestJson<TasksResponse>('/api/tasks');
}

export async function fetchSources(): Promise<SourcesResponse> {
  return requestJson<SourcesResponse>('/api/sources');
}

export async function fetchPolicy(collector: string): Promise<PolicyResponse> {
  return requestJson<PolicyResponse>(`/api/policy/${encodeURIComponent(collector)}`);
}

export async function fetchMetrics(window?: string): Promise<MetricsResponse> {
  const trimmed = (window ?? '').trim();
  const query = trimmed ? `?window=${encodeURIComponent(trimmed)}` : '';
  return requestJson<MetricsResponse>(`/api/metrics${query}`);
}

export async function revokePolicyRule(collector: string, ruleId: string): Promise<TaskMutationResponse> {
  return requestJson<TaskMutationResponse>(`/api/policy/${encodeURIComponent(collector)}/revoke`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ rule_id: ruleId }),
  });
}

export async function scanPolicy(collector: string, preview: boolean): Promise<PolicyScanResponse> {
  return requestJson<PolicyScanResponse>(`/api/policy/${encodeURIComponent(collector)}/scan`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ preview }),
  });
}

export async function recordRegret(taskId: string, kind: RegretKind, note: string): Promise<TaskMutationResponse> {
  const trimmedNote = note.trim();
  return requestJson<TaskMutationResponse>(`/api/tasks/${encodeURIComponent(taskId)}/regret`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ kind, ...(trimmedNote ? { note: trimmedNote } : {}) }),
  });
}

export interface UndoResponse {
  ok: true;
  task_id: string;
  reversibility?: string;
  undo_kind?: 'reverse' | 'correct' | 'corrective_card';
  status?: string;
}

export async function undoTask(taskId: string): Promise<UndoResponse> {
  return requestJson<UndoResponse>(`/api/tasks/${encodeURIComponent(taskId)}/undo`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
  });
}

export async function markReviewed(taskId: string): Promise<TaskMutationResponse> {
  return requestJson<TaskMutationResponse>(`/api/tasks/${encodeURIComponent(taskId)}/mark-reviewed`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
  });
}

export async function executeTask(taskId: string, optionId: string, feedback: string): Promise<TaskMutationResponse> {
  const trimmedFeedback = feedback.trim();
  return requestJson<TaskMutationResponse>(`/api/tasks/${encodeURIComponent(taskId)}/execute`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      option_id: optionId,
      ...(trimmedFeedback ? { feedback: trimmedFeedback } : {}),
    }),
  });
}

export async function dismissTask(taskId: string, reason: string): Promise<TaskMutationResponse> {
  const trimmedReason = reason.trim();
  return requestJson<TaskMutationResponse>(`/api/tasks/${encodeURIComponent(taskId)}/dismiss`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(trimmedReason ? { reason: trimmedReason } : {}),
  });
}

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  const payload = await parseJson(response);

  if (!response.ok || isErrorPayload(payload)) {
    throw new Error(errorMessageFromPayload(payload) ?? `${response.status} ${response.statusText}`.trim());
  }

  return payload as T;
}

async function parseJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error('API returned invalid JSON');
  }
}

function isErrorPayload(value: unknown): boolean {
  return isRecord(value) && value.ok === false;
}

function errorMessageFromPayload(value: unknown): string | null {
  if (!isRecord(value)) {
    return null;
  }
  const error = value.error;
  if (isRecord(error) && typeof error.message === 'string') {
    return error.message;
  }
  return typeof value.message === 'string' ? value.message : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
