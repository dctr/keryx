import { spawn } from 'node:child_process';

import type { KeryxConfig } from '../config';
import { mapWithConcurrency } from '../util/concurrency';
import { firstString, isNonEmptyString, isPlainObject } from '../util/object';
import type { ActionItem } from '../schemas/actionItem';
import type { ExecutionDecision } from '../schemas/executionDecision';
import type { PolicyDecision } from '../schemas/policyDecision';
import type { DeliveryTarget, HermesRunRequest, HermesRunResult, HermesRunner, KanbanTask } from './types';

export interface ListTaskOptions {
  status?: string;
  source?: string;
}

export class HermesCommandError extends Error {
  constructor(
    message: string,
    readonly request: HermesRunRequest,
    readonly result: HermesRunResult,
  ) {
    super(message);
    this.name = 'HermesCommandError';
  }
}

export class HermesCliAdapter {
  constructor(
    private readonly config: KeryxConfig,
    private readonly runner: HermesRunner = defaultHermesRunner,
  ) {}

  async listTasks(options: ListTaskOptions = {}): Promise<KanbanTask[]> {
    const args = ['kanban', '--board', this.config.board, 'list'];
    if (options.status) {
      args.push('--status', options.status);
    }
    if (options.source) {
      args.push('--tenant', options.source);
    }
    args.push('--json');

    return parseKanbanTasks(await this.run(args));
  }

  // Enriched listing for the batch/cron commands that read per-task comments (digest,
  // metrics, track-record bands, default-resolve, interrupt dedupe, policy show). The live
  // `hermes kanban list --json` does NOT embed comments — only `show --json` does — so we
  // list once, then fetch each task with showTask() and merge its comments back on. The N+1
  // calls are acceptable here: these are infrequent batch/cron paths, not hot request paths,
  // and correctness (populated comments) matters more than a single round trip. listTasks()
  // stays unchanged for callers (UI task list, doctor, list-cards) that never read comments.
  async listTasksWithComments(options: ListTaskOptions = {}): Promise<KanbanTask[]> {
    const tasks = await this.listTasks(options);
    return mapWithConcurrency(tasks, 8, async (task) => {
      const shown = await this.showTask(task.id);
      return { ...task, comments: shown.comments ?? [] };
    });
  }

  async showTask(taskId: string): Promise<KanbanTask> {
    return parseKanbanTask(await this.run(['kanban', '--board', this.config.board, 'show', taskId, '--json']));
  }

  async createTaskFromActionItem(actionItem: ActionItem, shadowDecision?: PolicyDecision): Promise<unknown> {
    // TODO(https://github.com/NousResearch/hermes-agent/issues/39609): replace this
    // create→block→assign workaround with atomic sticky-blocked creation once Hermes
    // `--initial-status blocked` no longer auto-promotes.
    const created = parseJson(await this.run(this.createCardArgs(actionItem)));
    const taskId = extractCreatedTaskId(created);
    if (!createdTaskAlreadyBlocked(created)) {
      await this.blockTask(taskId, 'approval-required: Keryx candidate awaiting user decision');
    }
    await this.assignTask(taskId, this.config.defaultAssignee);
    // Shadow mode (PRD §10.1): a shadow rule "would have" run this silently. Record the
    // disposition function's reasoning on the still-blocked card so the user can judge
    // stability before promoting shadow → active, without granting any autonomy now.
    if (shadowDecision) {
      await this.commentTask(taskId, JSON.stringify(shadowDecision));
    }
    return created;
  }

  // Silent disposition path (PRD §7.4, §9): create the card, attach the validated
  // synthetic policy-decision comment that authorizes silent execution, then promote
  // it straight to `ready` so the worker is dispatched without a human approval step.
  // The worker (skill) is what actually executes once dispatched.
  async createReadyTaskFromActionItem(actionItem: ActionItem, policyDecision: PolicyDecision): Promise<unknown> {
    const created = parseJson(await this.run(this.createCardArgs(actionItem)));
    const taskId = extractCreatedTaskId(created);
    await this.commentTask(taskId, JSON.stringify(policyDecision));
    await this.promoteTask(taskId, 'approved by Keryx policy');
    return created;
  }

  // Honest-undo path (PRD §7.4, D3): create a reversal/correction card authorized by the
  // user's explicit undo click — a trusted review-path keryx.execution_decision.v1 — then
  // promote it to `ready` so the worker runs the reversal/correction without a second
  // approval step. Distinct from createReadyTaskFromActionItem (whose authority is a
  // synthetic policy decision); here a human asked for the undo.
  async createReadyTaskFromExecutionDecision(
    actionItem: ActionItem,
    executionDecision: ExecutionDecision,
  ): Promise<unknown> {
    const created = parseJson(await this.run(this.createCardArgs(actionItem)));
    const taskId = extractCreatedTaskId(created);
    await this.commentTask(taskId, JSON.stringify(executionDecision));
    await this.promoteTask(taskId, 'approved by Keryx undo');
    return created;
  }

  private createCardArgs(actionItem: ActionItem): string[] {
    return [
      'kanban',
      '--board',
      this.config.board,
      'create',
      actionItem.title,
      '--body',
      JSON.stringify(actionItem),
      '--tenant',
      actionItem.source,
      '--idempotency-key',
      actionItem.idempotency_key,
      '--created-by',
      actionItem.collector,
      '--skill',
      'keryx:keryx-worker',
      '--json',
    ];
  }

  async blockTask(taskId: string, reason: string): Promise<unknown> {
    return this.run(['kanban', '--board', this.config.board, 'block', taskId, reason]);
  }

  async assignTask(taskId: string, assignee: string): Promise<unknown> {
    return this.run(['kanban', '--board', this.config.board, 'assign', taskId, assignee]);
  }

  async commentTask(taskId: string, body: string): Promise<unknown> {
    return this.run(['kanban', '--board', this.config.board, 'comment', taskId, body]);
  }

  async promoteTask(taskId: string, reason = 'approved from Keryx'): Promise<unknown> {
    return parseJson(await this.run(['kanban', '--board', this.config.board, 'promote', taskId, reason, '--json']));
  }

  async archiveTask(taskId: string): Promise<unknown> {
    return this.run(['kanban', '--board', this.config.board, 'archive', taskId]);
  }

  async dispatch(): Promise<unknown> {
    return parseJson(await this.run(['kanban', '--board', this.config.board, 'dispatch', '--json']));
  }

  async listCronJobs(): Promise<unknown> {
    return { jobs: parseCronListText(await this.run(['cron', 'list', '--all'])) };
  }

  async listDeliveryTargets(platform?: string): Promise<DeliveryTarget[]> {
    const args = platform ? ['send', '--list', platform, '--json'] : ['send', '--list', '--json'];
    return parseDeliveryTargets(await this.run(args));
  }

  // The single new state-changing privilege in v005 (PRD §7.5, §11.12): deliver an
  // interrupt or digest message to a configured target. Mirrors the real `hermes send`
  // CLI shape (`hermes send --to TARGET <message>`), kept exact so this cannot become a
  // generic send passthrough (no --file/--subject/--quiet etc.).
  async sendMessage(target: string, message: string): Promise<string> {
    return this.run(['send', '--to', target, message]);
  }

  // Returns the raw `hermes --version` stdout. Callers parse the semver with
  // parseHermesVersion(); the adapter does not interpret the output so that a
  // cosmetic format change degrades to a WARN rather than a hard failure.
  async getVersion(): Promise<string> {
    return this.run(['--version']);
  }

  private async run(args: string[]): Promise<string> {
    assertAllowedHermesArgs(args);
    const request: HermesRunRequest = {
      bin: this.config.hermesBin,
      args,
      env: this.config.hermesHome ? { HERMES_HOME: this.config.hermesHome } : {},
    };
    const result = await this.runner(request);

    if (result.exitCode !== 0) {
      throw new HermesCommandError(
        `Hermes command failed with exit code ${result.exitCode}: ${result.stderr || result.stdout}`,
        request,
        result,
      );
    }

    return result.stdout;
  }
}

export function assertAllowedHermesArgs(args: readonly string[]): void {
  if (
    isAllowedKanbanArgs(args) ||
    isAllowedSendArgs(args) ||
    isAllowedSendMessageArgs(args) ||
    isAllowedCronArgs(args) ||
    isAllowedVersionArgs(args)
  ) {
    return;
  }

  throw new Error(`Hermes command shape is not allowlisted: ${args.join(' ')}`);
}

function isAllowedKanbanArgs(args: readonly string[]): boolean {
  if (args.length < 5 || args[0] !== 'kanban' || args[1] !== '--board' || !isNonEmptyString(args[2])) {
    return false;
  }

  const command = args[3];
  const rest = args.slice(4);

  switch (command) {
    case 'list':
      return isAllowedKanbanListRest(rest);
    case 'show':
      return rest.length === 2 && isNonEmptyString(rest[0]) && rest[1] === '--json';
    case 'create':
      return isAllowedKanbanCreateRest(rest);
    case 'block':
      return rest.length === 2 && isNonEmptyString(rest[0]) && isNonEmptyString(rest[1]);
    case 'assign':
      return rest.length === 2 && isNonEmptyString(rest[0]) && isNonEmptyString(rest[1]);
    case 'promote':
      return rest.length === 3 && isNonEmptyString(rest[0]) && isNonEmptyString(rest[1]) && rest[2] === '--json';
    case 'comment':
      return rest.length >= 2 && rest.every(isNonEmptyString);
    case 'archive':
      return rest.length >= 1 && rest.every(isNonEmptyString);
    case 'dispatch':
      return rest.length === 1 && rest[0] === '--json';
    default:
      return false;
  }
}

function isAllowedKanbanListRest(rest: readonly string[]): boolean {
  const remaining = [...rest];

  while (remaining.length > 0 && remaining[0] !== '--json') {
    const flag = remaining.shift();
    const value = remaining.shift();
    if ((flag !== '--status' && flag !== '--tenant') || !isNonEmptyString(value)) {
      return false;
    }
  }

  return remaining.length === 1 && remaining[0] === '--json';
}

function isAllowedKanbanCreateRest(rest: readonly string[]): boolean {
  return (
    rest.length === 12 &&
    isNonEmptyString(rest[0]) &&
    rest[1] === '--body' &&
    isNonEmptyString(rest[2]) &&
    rest[3] === '--tenant' &&
    isNonEmptyString(rest[4]) &&
    rest[5] === '--idempotency-key' &&
    isNonEmptyString(rest[6]) &&
    rest[7] === '--created-by' &&
    isNonEmptyString(rest[8]) &&
    rest[9] === '--skill' &&
    rest[10] === 'keryx:keryx-worker' &&
    rest[11] === '--json'
  );
}

function extractCreatedTaskId(created: unknown): string {
  if (isPlainObject(created)) {
    for (const key of ['id', 'task_id']) {
      const value = created[key];
      if (isNonEmptyString(value)) {
        return value;
      }
    }
  }
  throw new Error('Hermes Kanban create JSON did not contain a task id');
}

function createdTaskAlreadyBlocked(created: unknown): boolean {
  return isPlainObject(created) && created.status === 'blocked';
}

function isAllowedSendArgs(args: readonly string[]): boolean {
  return (
    args[0] === 'send' &&
    args[1] === '--list' &&
    ((args.length === 3 && args[2] === '--json') || (args.length === 4 && isNonEmptyString(args[2]) && args[3] === '--json'))
  );
}

// The narrow interrupt/digest delivery shape: `hermes send --to <target> <message>`.
// Exact arity (4) and both target+message non-empty, with no trailing flags
// (--file/--subject/--quiet/--json etc.) so this stays a single-purpose privilege.
function isAllowedSendMessageArgs(args: readonly string[]): boolean {
  return (
    args.length === 4 &&
    args[0] === 'send' &&
    args[1] === '--to' &&
    isNonEmptyString(args[2]) &&
    isNonEmptyString(args[3])
  );
}

function isAllowedCronArgs(args: readonly string[]): boolean {
  return args.length === 3 && args[0] === 'cron' && args[1] === 'list' && args[2] === '--all';
}

// The only top-level Hermes command shape Keryx is permitted to run: `hermes --version`.
// Kept exact so the doctor version check cannot become a generic Hermes passthrough.
function isAllowedVersionArgs(args: readonly string[]): boolean {
  return args.length === 1 && args[0] === '--version';
}

// Defensively extracts a dotted three-part semver (major.minor.patch) from arbitrary
// `hermes --version` output. Tolerates an optional `v` prefix ("...v0.16.0...") and takes
// the first such token, so a cosmetic prefix change keeps parsing and an unrelated
// trailing build/date stamp ("(2026.6.5)") is not mistaken for the version. Returns null
// when no full semver is present, which the caller surfaces as a WARN, not a failure.
export function parseHermesVersion(output: string): string | null {
  const match = output.match(/(?<![\w.])v?(\d+)\.(\d+)\.(\d+)(?![\w.])/);
  return match ? `${match[1]}.${match[2]}.${match[3]}` : null;
}

export function parseKanbanTasks(json: string): KanbanTask[] {
  const parsed = parseJson(json);
  if (!Array.isArray(parsed)) {
    throw new Error('Hermes Kanban list JSON did not contain a task array');
  }

  return parsed.map(normaliseKanbanTask);
}

export function parseKanbanTask(json: string): KanbanTask {
  const parsed = parseJson(json);
  if (!isPlainObject(parsed) || !isPlainObject(parsed.task)) {
    throw new Error('Hermes Kanban show JSON did not contain a task object');
  }
  const task = normaliseKanbanTask(parsed.task);
  // The live `hermes kanban show --json` returns `comments` as a TOP-LEVEL sibling of
  // `task`, not nested inside it. Merge the sibling on so comment-reading callers
  // (digest/metrics/track-record/default-resolve/dedupe) actually see them. Fall back to
  // a nested `task.comments` if a future envelope embeds them there instead.
  if (Array.isArray(parsed.comments)) {
    return { ...task, comments: parsed.comments as KanbanTask['comments'] };
  }
  return task;
}

export function parseDeliveryTargets(json: string): DeliveryTarget[] {
  const parsed = parseJson(json);
  const candidates = findDeliveryTargetCandidates(parsed);
  return candidates.map(normaliseDeliveryTarget).filter((target): target is DeliveryTarget => target !== null);
}

export function parseCronListText(text: string): Array<Record<string, unknown>> {
  const jobs: Array<Record<string, unknown>> = [];
  let current: Record<string, unknown> | null = null;

  for (const line of text.split(/\r?\n/)) {
    const header = line.match(/^\s{2,}(\S+)\s+\[([^\]]+)]\s*$/);
    if (header) {
      if (current) {
        jobs.push(current);
      }
      const state = header[2];
      current = { id: header[1], enabled: state === 'active', state };
      continue;
    }

    if (!current) {
      continue;
    }

    const field = line.match(/^\s{4,}([^:]+):\s*(.*)$/);
    if (!field) {
      continue;
    }

    const key = field[1].trim().toLowerCase();
    const value = field[2].trim();
    switch (key) {
      case 'name':
        current.name = value;
        break;
      case 'schedule':
        current.schedule = value;
        break;
      case 'next run':
        current.next_run_at = value;
        break;
      case 'last run': {
        const parsed = value.match(/^(.+?)\s+([^\s]+)$/);
        if (parsed) {
          current.last_run_at = parsed[1];
          current.last_status = parsed[2];
        } else {
          current.last_run_at = value;
        }
        break;
      }
      default:
        break;
    }
  }

  if (current) {
    jobs.push(current);
  }

  return jobs.filter((job) => typeof job.name === 'string' && job.name.length > 0);
}

function findDeliveryTargetCandidates(value: unknown): unknown[] {
  if (!isPlainObject(value)) {
    return [];
  }

  return getPlatformDeliveryTargetCandidates(value);
}

function getPlatformDeliveryTargetCandidates(value: Record<string, unknown>): unknown[] {
  if (!isPlainObject(value.platforms)) {
    return [];
  }

  const candidates: unknown[] = [];
  for (const [platform, targets] of Object.entries(value.platforms)) {
    if (!Array.isArray(targets) || targets.length === 0) {
      continue;
    }

    candidates.push({ target: platform, label: `${platform} home`, platform });

    for (const target of targets) {
      if (typeof target === 'string') {
        candidates.push({ target: `${platform}:${target}`, platform });
        continue;
      }

      if (!isPlainObject(target)) {
        continue;
      }

      const explicitTarget = firstString(target.target, target.value, target.address);
      const id = firstString(target.id);
      candidates.push({
        ...target,
        target: explicitTarget ?? (id ? `${platform}:${id}` : undefined),
        platform,
      });
    }
  }

  return candidates;
}

function normaliseDeliveryTarget(value: unknown): DeliveryTarget | null {
  if (!isPlainObject(value)) {
    return null;
  }

  const target = firstString(value.target, value.id, value.value, value.address);
  if (!target) {
    return null;
  }

  const label = firstString(value.label, value.name, value.title, value.description);
  const platform = firstString(value.platform, value.type);

  return {
    target,
    ...(label ? { label } : {}),
    ...(platform ? { platform } : {}),
  };
}

function normaliseKanbanTask(value: unknown): KanbanTask {
  if (!isPlainObject(value) || !isNonEmptyString(value.id)) {
    throw new Error('Hermes Kanban JSON task is missing a string id');
  }

  return value as unknown as KanbanTask;
}

function parseJson(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch (error) {
    throw new Error(`Invalid Hermes JSON output: ${error instanceof Error ? error.message : String(error)}`);
  }
}



export async function defaultHermesRunner(request: HermesRunRequest): Promise<HermesRunResult> {
  const timeoutMs = request.timeoutMs ?? 30_000;
  return new Promise((resolve, reject) => {
    const child = spawn(request.bin, request.args, {
      env: { ...process.env, ...dropUndefined(request.env) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGTERM');
      reject(new Error(`Hermes runner timed out after ${timeoutMs}ms: ${request.bin} ${request.args.join(' ')}`));
    }, timeoutMs);

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode: code ?? 1 });
    });
  });
}

function dropUndefined(env: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined));
}
