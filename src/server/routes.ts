import type { FastifyInstance, FastifyReply } from 'fastify';

import type { KeryxConfig } from '../config';
import type { ListTaskOptions } from '../hermes/adapter';
import type { HermesRunner, KanbanTask } from '../hermes/types';
import { type RunOpsctlOptions } from '../opsctl/commands';
import type { CommandResult } from '../opsctl/output';
import { formatValidationErrors } from '../opsctl/output';
import { type ActionItem, validateActionItem } from '../schemas/actionItem';

export type OpsctlRunner = (argv: string[], options?: RunOpsctlOptions) => Promise<CommandResult>;

export interface ServerHermesAdapter {
  listTasks(options?: ListTaskOptions): Promise<KanbanTask[]>;
  listCronJobs(): Promise<unknown>;
}

export interface RegisterApiRoutesOptions {
  adapter: ServerHermesAdapter;
  config: KeryxConfig;
  hermesRunner?: HermesRunner;
  runOpsctl: OpsctlRunner;
  opsctlOptions: RunOpsctlOptions;
  now?: () => Date;
}

interface TaskParams {
  id: string;
}

interface ApiTask {
  id: string;
  title: string | null;
  status: string;
  source: string;
  tenant: string | null;
  created_by: string | null;
  action_item: ActionItem;
}

interface MalformedTaskError {
  task_id: string;
  title: string | null;
  status: string;
  error: string;
}

interface SourceStatus {
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

export function registerApiRoutes(server: FastifyInstance, options: RegisterApiRoutesOptions): void {
  server.get('/api/health', async (_request, reply) => {
    noStore(reply);
    return { ok: true, app: 'Keryx' };
  });

  server.get('/api/tasks', async (_request, reply) => {
    noStore(reply);
    try {
      const tasks = await options.adapter.listTasks();
      const parsed: ApiTask[] = [];
      const errors: MalformedTaskError[] = [];

      for (const task of tasks) {
        const body = parseActionItemFromTask(task);
        if (!body.ok) {
          errors.push({
            task_id: task.id,
            title: stringOrNull(task.title),
            status: taskStatus(task),
            error: body.message,
          });
          continue;
        }

        parsed.push({
          id: task.id,
          title: stringOrNull(task.title),
          status: taskStatus(task),
          source: body.actionItem.source,
          tenant: stringOrNull(task.tenant),
          created_by: stringOrNull(task.created_by),
          action_item: body.actionItem,
        });
      }

      return { ok: true, tasks: parsed, errors };
    } catch (error) {
      return sendApiError(reply, 502, 'HERMES_ERROR', errorMessage(error));
    }
  });

  server.get('/api/sources', async (_request, reply) => {
    noStore(reply);
    try {
      const jobs = normaliseCronJobs(await options.adapter.listCronJobs()).filter((job) => job.name.startsWith('keryx-'));
      return { ok: true, sources: jobs.map(toSourceStatus) };
    } catch (error) {
      return sendApiError(reply, 502, 'HERMES_ERROR', errorMessage(error));
    }
  });

  server.post<{ Params: TaskParams }>('/api/tasks/:id/execute', async (request, reply) => {
    noStore(reply);
    const idCheck = validateTaskId(request.params.id);
    if (!idCheck.ok) {
      return sendApiError(reply, 400, 'VALIDATION_ERROR', idCheck.message);
    }

    const body = requestBodyObject(request.body);
    if (!body.ok) {
      return sendApiError(reply, 400, 'VALIDATION_ERROR', 'request body must be a JSON object');
    }

    const optionId = firstString(body.value.option_id, body.value.selected_option_id);
    if (!optionId) {
      return sendApiError(reply, 400, 'VALIDATION_ERROR', 'option_id must be a non-empty string');
    }

    const feedback = optionalString(body.value.feedback, 'feedback');
    if (!feedback.ok) {
      return sendApiError(reply, 400, 'VALIDATION_ERROR', feedback.message);
    }

    const argv = ['execute', request.params.id, '--option', optionId];
    if (feedback.value) {
      argv.push('--feedback', feedback.value);
    }

    const result = await options.runOpsctl(argv, buildOpsctlOptions(options));
    return sendCommandResult(reply, result);
  });

  server.post<{ Params: TaskParams }>('/api/tasks/:id/dismiss', async (request, reply) => {
    noStore(reply);
    const idCheck = validateTaskId(request.params.id);
    if (!idCheck.ok) {
      return sendApiError(reply, 400, 'VALIDATION_ERROR', idCheck.message);
    }

    const body = requestBodyObject(request.body);
    if (!body.ok) {
      return sendApiError(reply, 400, 'VALIDATION_ERROR', 'request body must be a JSON object');
    }

    const reason = optionalString(body.value.reason, 'reason');
    if (!reason.ok) {
      return sendApiError(reply, 400, 'VALIDATION_ERROR', reason.message);
    }

    const argv = ['dismiss', request.params.id];
    if (reason.value) {
      argv.push('--reason', reason.value);
    }

    const result = await options.runOpsctl(argv, buildOpsctlOptions(options));
    return sendCommandResult(reply, result);
  });

  // Honest undo (PRD §7.4, D3): reverse/correct an executed card per its reversibility.
  // Delegates to the shared opsctl logic, which reads the executed option's reversibility
  // and creates the appropriate reversal / labeled-correction / corrective-triage card.
  server.post<{ Params: TaskParams }>('/api/tasks/:id/undo', async (request, reply) => {
    noStore(reply);
    const idCheck = validateTaskId(request.params.id);
    if (!idCheck.ok) {
      return sendApiError(reply, 400, 'VALIDATION_ERROR', idCheck.message);
    }

    const result = await options.runOpsctl(['undo', request.params.id], buildOpsctlOptions(options));
    return sendCommandResult(reply, result);
  });

  // Mark-reviewed (PRD §7.10, §9): archive a reviewed review-log (done) card so it leaves
  // the review log. Delegates to the dedicated opsctl `mark-reviewed` command, which writes
  // a `keryx:reviewed` marker comment and archives the card.
  server.post<{ Params: TaskParams }>('/api/tasks/:id/mark-reviewed', async (request, reply) => {
    noStore(reply);
    const idCheck = validateTaskId(request.params.id);
    if (!idCheck.ok) {
      return sendApiError(reply, 400, 'VALIDATION_ERROR', idCheck.message);
    }

    const result = await options.runOpsctl(['mark-reviewed', request.params.id], buildOpsctlOptions(options));
    return sendCommandResult(reply, result);
  });

  // Escalation-regret signal (PRD §7.9): one-click feedback that feeds confidence bands.
  server.post<{ Params: TaskParams }>('/api/tasks/:id/regret', async (request, reply) => {
    noStore(reply);
    const idCheck = validateTaskId(request.params.id);
    if (!idCheck.ok) {
      return sendApiError(reply, 400, 'VALIDATION_ERROR', idCheck.message);
    }

    const body = requestBodyObject(request.body);
    if (!body.ok) {
      return sendApiError(reply, 400, 'VALIDATION_ERROR', 'request body must be a JSON object');
    }

    const kind = body.value.kind;
    if (kind !== 'should_have_acted' && kind !== 'should_have_asked') {
      return sendApiError(reply, 400, 'VALIDATION_ERROR', 'kind must be should_have_acted or should_have_asked');
    }

    const note = optionalString(body.value.note, 'note');
    if (!note.ok) {
      return sendApiError(reply, 400, 'VALIDATION_ERROR', note.message);
    }

    const argv = ['regret', request.params.id, '--kind', kind];
    if (note.value) {
      argv.push('--note', note.value);
    }

    const result = await options.runOpsctl(argv, buildOpsctlOptions(options));
    return sendCommandResult(reply, result);
  });

  // Policy inspection (PRD §9): read a collector's active/shadow rules + derived bands.
  server.get<{ Params: { collector: string } }>('/api/policy/:collector', async (request, reply) => {
    noStore(reply);
    const check = validateCollectorName(request.params.collector);
    if (!check.ok) {
      return sendApiError(reply, 400, 'VALIDATION_ERROR', check.message);
    }

    const result = await options.runOpsctl(['policy', 'show', request.params.collector, '--json'], buildOpsctlOptions(options));
    return sendCommandResult(reply, result);
  });

  // Policy revocation (PRD §9): auditable human-approved change — creates a revocation card.
  server.post<{ Params: { collector: string } }>('/api/policy/:collector/revoke', async (request, reply) => {
    noStore(reply);
    const check = validateCollectorName(request.params.collector);
    if (!check.ok) {
      return sendApiError(reply, 400, 'VALIDATION_ERROR', check.message);
    }

    const body = requestBodyObject(request.body);
    if (!body.ok) {
      return sendApiError(reply, 400, 'VALIDATION_ERROR', 'request body must be a JSON object');
    }

    const ruleId = firstString(body.value.rule_id, body.value.rule);
    if (!ruleId) {
      return sendApiError(reply, 400, 'VALIDATION_ERROR', 'rule_id must be a non-empty string');
    }

    const result = await options.runOpsctl(
      ['policy', 'revoke', request.params.collector, '--rule', ruleId],
      buildOpsctlOptions(options),
    );
    return sendCommandResult(reply, result);
  });

  // Attention-economics metrics (PRD §9, §11): derived read-only from the Kanban audit trail.
  server.get<{ Querystring: { window?: string } }>('/api/metrics', async (request, reply) => {
    noStore(reply);
    const argv = ['metrics'];
    const window = optionalString(request.query.window, 'window');
    if (!window.ok) {
      return sendApiError(reply, 400, 'VALIDATION_ERROR', window.message);
    }
    if (window.value) {
      argv.push('--window', window.value);
    }
    argv.push('--json');

    const result = await options.runOpsctl(argv, buildOpsctlOptions(options));
    return sendCommandResult(reply, result);
  });
}

function noStore(reply: FastifyReply): void {
  reply.header('cache-control', 'no-store');
}

function buildOpsctlOptions(options: RegisterApiRoutesOptions): RunOpsctlOptions {
  return {
    ...options.opsctlOptions,
    config: options.config,
    hermesRunner: options.hermesRunner ?? options.opsctlOptions.hermesRunner,
    ...(options.now ? { now: options.now } : {}),
  };
}

function sendCommandResult(reply: FastifyReply, result: CommandResult) {
  if (result.exitCode !== 0) {
    return sendApiError(reply, 400, 'OPSCTL_ERROR', cleanOpsctlError(result.stderr || result.stdout || 'opsctl failed'));
  }

  try {
    return reply.code(200).send(JSON.parse(result.stdout) as unknown);
  } catch {
    return reply.code(200).send({ ok: true, output: result.stdout.trim() });
  }
}

function sendApiError(reply: FastifyReply, statusCode: number, code: string, message: string) {
  return reply.code(statusCode).send({ ok: false, error: { code, message } });
}

function cleanOpsctlError(value: string): string {
  return value.trim().replace(/^FAIL\s+/, '');
}

function requestBodyObject(value: unknown): { ok: true; value: Record<string, unknown> } | { ok: false } {
  if (value === undefined || value === null) {
    return { ok: true, value: {} };
  }
  return isPlainObject(value) ? { ok: true, value } : { ok: false };
}

// Rejects task ids that begin with "-" (after trimming) so they cannot reach
// Hermes argv as option-lookalikes. Mirrors the opsctl execute/dismiss guard.
function validateTaskId(id: string): { ok: true } | { ok: false; message: string } {
  if (id.trim().startsWith('-')) {
    return { ok: false, message: 'task id must not begin with "-"' };
  }
  return { ok: true };
}

// Restricts a policy collector path segment to the safe id charset so it cannot reach
// the opsctl/Hermes argv as an option-lookalike or path-traversal token.
function validateCollectorName(collector: string): { ok: true } | { ok: false; message: string } {
  if (!/^[A-Za-z0-9_.:-]+$/.test(collector) || collector.startsWith('-')) {
    return { ok: false, message: 'collector must match [A-Za-z0-9_.:-] and not begin with "-"' };
  }
  return { ok: true };
}

function optionalString(value: unknown, field: string): { ok: true; value: string | null } | { ok: false; message: string } {
  if (value === undefined || value === null) {
    return { ok: true, value: null };
  }
  if (typeof value !== 'string') {
    return { ok: false, message: `${field} must be a string when supplied` };
  }
  const trimmed = value.trim();
  return { ok: true, value: trimmed.length > 0 ? trimmed : null };
}

function parseActionItemFromTask(task: KanbanTask): { ok: true; actionItem: ActionItem } | { ok: false; message: string } {
  if (typeof task.body !== 'string') {
    return { ok: false, message: 'task body is not a JSON string' };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(task.body) as unknown;
  } catch (error) {
    return { ok: false, message: `task body is not valid JSON: ${errorMessage(error)}` };
  }

  const validation = validateActionItem(parsed);
  if (!validation.ok) {
    return { ok: false, message: formatValidationErrors(validation.errors) };
  }

  return { ok: true, actionItem: validation.value };
}

function normaliseCronJobs(value: unknown): SourceStatus[] {
  return cronJobCandidates(value).map(normaliseCronJob).filter((job): job is SourceStatus => job !== null);
}

function cronJobCandidates(value: unknown): unknown[] {
  if (Array.isArray(value)) {
    return value;
  }
  if (!isPlainObject(value)) {
    return [];
  }

  for (const key of ['jobs', 'cron_jobs', 'items', 'results']) {
    if (Array.isArray(value[key])) {
      return value[key];
    }
  }

  return Object.values(value).flatMap((entry) => (Array.isArray(entry) ? entry : []));
}

function normaliseCronJob(value: unknown): SourceStatus | null {
  if (typeof value === 'string') {
    return { name: value, source: sourceFromJobName(value), status: 'UNKNOWN', enabled: true };
  }
  if (!isPlainObject(value)) {
    return null;
  }

  const name = firstString(value.name, value.id, value.job_id, value.prompt);
  if (!name) {
    return null;
  }

  const enabled = inferCronEnabled(value);
  const job: SourceStatus = {
    ...(firstString(value.id, value.job_id) ? { id: firstString(value.id, value.job_id) } : {}),
    name,
    source: sourceFromJobName(name),
    status: 'UNKNOWN',
    enabled,
    ...(firstString(value.schedule, value.cron, value.interval) ? { schedule: firstString(value.schedule, value.cron, value.interval) } : {}),
    ...(firstString(value.last_status, value.status) ? { last_status: firstString(value.last_status, value.status) } : {}),
    ...(firstString(value.last_run_at, value.lastRunAt, value.last_run) ? { last_run_at: firstString(value.last_run_at, value.lastRunAt, value.last_run) } : {}),
    ...(firstString(value.last_success_at, value.lastSuccessAt) ? { last_success_at: firstString(value.last_success_at, value.lastSuccessAt) } : {}),
    ...(firstString(value.last_error, value.error) ? { last_error: firstString(value.last_error, value.error) } : {}),
    ...(firstString(value.last_delivery_error, value.delivery_error)
      ? { last_delivery_error: firstString(value.last_delivery_error, value.delivery_error) }
      : {}),
    ...(firstString(value.next_run_at, value.nextRunAt, value.next_run) ? { next_run_at: firstString(value.next_run_at, value.nextRunAt, value.next_run) } : {}),
    ...(firstString(value.state) ? { state: firstString(value.state) } : {}),
  };
  job.status = inferSourceStatus(job);
  return job;
}

function toSourceStatus(job: SourceStatus): SourceStatus {
  return job;
}

function inferCronEnabled(value: Record<string, unknown>): boolean {
  if (typeof value.enabled === 'boolean') {
    return value.enabled;
  }
  if (typeof value.paused === 'boolean') {
    return !value.paused;
  }

  const status = firstString(value.status, value.state);
  if (status) {
    return !['paused', 'disabled', 'stopped'].includes(status.toLowerCase());
  }

  return true;
}

function inferSourceStatus(job: SourceStatus): SourceStatus['status'] {
  if (!job.enabled) {
    return 'PAUSED';
  }

  const status = (job.last_status ?? job.state ?? '').toLowerCase();
  if (job.last_error || job.last_delivery_error || ['error', 'failed', 'failure'].includes(status)) {
    return 'FAILED';
  }
  if (['success', 'succeeded', 'ok', 'completed'].includes(status)) {
    return 'OK';
  }

  return 'UNKNOWN';
}

function sourceFromJobName(name: string): string {
  return name.startsWith('keryx-') ? name.slice('keryx-'.length) : name;
}

function taskStatus(task: KanbanTask): string {
  return typeof task.status === 'string' && task.status.trim().length > 0 ? task.status : 'unknown';
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function firstString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === 'string' && value.trim().length > 0)?.trim();
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
