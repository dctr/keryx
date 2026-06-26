// Shared types, flags helpers, and small pure utilities used by two or more
// opsctl command-group modules. Keeping them here avoids circular imports
// between commands.ts (the thin dispatcher) and the group files it imports.

import { readFileSync } from 'node:fs';

import { isPlainObject, firstString } from '../util/object';
import { cronJobCandidates, inferCronEnabled } from '../hermes/cronNormalise';
import { parseActionItemFromTask } from '../hermes/taskBody';
import type { HermesRunner, KanbanTask } from '../hermes/types';
import type { HermesCliAdapter } from '../hermes/adapter';
import type { KeryxConfig } from '../config';
import type { CronJobSummary } from './output';

// ---------------------------------------------------------------------------
// RunOpsctlOptions — shared across commands.ts and every command-group file
// ---------------------------------------------------------------------------

export interface RunOpsctlOptions {
  config?: KeryxConfig;
  configPath?: string | null;
  cwd?: string;
  env?: Record<string, string | undefined>;
  hermesRunner?: HermesRunner;
  now?: () => Date;
}

// ---------------------------------------------------------------------------
// ParsedArgs — returned by parseArgs in commands.ts, passed to group functions
// ---------------------------------------------------------------------------

export interface ParsedArgs {
  command: string;
  positionals: string[];
  flags: Map<string, string | boolean>;
}

// ---------------------------------------------------------------------------
// CommandContext — built once in runOpsctl and passed to every handler.
// Handlers destructure only what they need. `now` is always resolved so
// handlers never repeat `options.now ?? (() => new Date())`.
// ---------------------------------------------------------------------------

export interface CommandContext {
  parsed: ParsedArgs;
  adapter: HermesCliAdapter;
  config: KeryxConfig;
  now: () => Date;
  options: RunOpsctlOptions;
}

// ---------------------------------------------------------------------------
// Flag helpers — used by almost every command-group function
// ---------------------------------------------------------------------------

export function stringFlag(parsed: ParsedArgs, name: string): string | undefined {
  const value = parsed.flags.get(name);
  return typeof value === 'string' ? value : undefined;
}

// ---------------------------------------------------------------------------
// parseJsonFile — used by validate, cards, and policy groups
// ---------------------------------------------------------------------------

export function parseJsonFile(filePath: string): unknown {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8')) as unknown;
  } catch (error) {
    throw new Error(`invalid JSON file ${filePath}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
}

// ---------------------------------------------------------------------------
// normaliseTaskStatus — used by lifecycle and undo groups
// ---------------------------------------------------------------------------

export function normaliseTaskStatus(task: KanbanTask): string {
  return typeof task.status === 'string' && task.status.trim().length > 0 ? task.status : 'unknown';
}

// ---------------------------------------------------------------------------
// validateTaskIdArgument — used by lifecycle, undo, and regret groups
// ---------------------------------------------------------------------------

import type { CommandResult } from './output';
import { fail } from './output';

// Rejects task ids that begin with "-" (after trimming) so they cannot reach
// Hermes argv as option-lookalikes. Mirrors the API route guard. Returns a
// failing CommandResult (exit 2) when invalid, or undefined when acceptable.
export function validateTaskIdArgument(taskId: string): CommandResult | undefined {
  return taskId.trim().startsWith('-') ? fail('FAIL task id must not begin with "-"', 2) : undefined;
}

// ---------------------------------------------------------------------------
// validateTaskBody — used by cards (showCard) and doctor
// ---------------------------------------------------------------------------

export function validateTaskBody(task: KanbanTask): { ok: true } | { ok: false; message: string } {
  const parsed = parseActionItemFromTask(task);
  return parsed.ok ? { ok: true } : { ok: false, message: parsed.message };
}

// ---------------------------------------------------------------------------
// normaliseCronJobs — used by cards (cron-status) and doctor
// ---------------------------------------------------------------------------

export function normaliseCronJobs(value: unknown): CronJobSummary[] {
  return cronJobCandidates(value).map(normaliseCronJob).filter((job): job is CronJobSummary => job !== null);
}

function normaliseCronJob(value: unknown): CronJobSummary | null {
  if (typeof value === 'string') {
    return { name: value, enabled: true };
  }
  if (!isPlainObject(value)) {
    return null;
  }

  const name = firstString(value.name, value.id, value.job_id, value.prompt);
  if (!name) {
    return null;
  }

  return {
    ...(firstString(value.id, value.job_id) ? { id: firstString(value.id, value.job_id) } : {}),
    name,
    enabled: inferCronEnabled(value),
    ...(firstString(value.schedule, value.cron, value.interval) ? { schedule: firstString(value.schedule, value.cron, value.interval) } : {}),
  };
}

// ---------------------------------------------------------------------------
// collectorSource — used by cards (deriveBandForClass) and policy group
// ---------------------------------------------------------------------------

// The source name a collector polls (its Kanban tenant): keryx-email -> email.
export function collectorSource(collector: string): string {
  return collector.startsWith('keryx-') ? collector.slice('keryx-'.length) : collector;
}
