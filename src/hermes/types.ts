export type KanbanStatus = 'todo' | 'blocked' | 'ready' | 'running' | 'done' | 'archived' | 'scheduled' | 'review';

export interface HermesRunRequest {
  bin: string;
  args: string[];
  env: Record<string, string | undefined>;
  timeoutMs?: number;
}

export interface HermesRunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export type HermesRunner = (request: HermesRunRequest) => Promise<HermesRunResult>;

export interface KanbanComment {
  body?: string;
  created_at?: string | number;
  [key: string]: unknown;
}

export interface KanbanTask {
  id: string;
  title?: string;
  status?: KanbanStatus | string;
  body?: string;
  tenant?: string | null;
  created_by?: string | null;
  comments?: KanbanComment[];
  [key: string]: unknown;
}

export interface DeliveryTarget {
  target: string;
  label?: string;
  platform?: string;
}
