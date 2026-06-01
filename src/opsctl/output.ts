import type { DeliveryTarget, KanbanTask } from '../hermes/types';
import type { ValidationError } from '../schemas/validate';

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface DoctorLine {
  level: 'OK' | 'WARN' | 'FAIL';
  check: string;
  message: string;
}

export interface CronJobSummary {
  id?: string;
  name: string;
  enabled: boolean;
  schedule?: string;
}

export function ok(stdout: string): CommandResult {
  return { exitCode: 0, stdout: ensureTrailingNewline(stdout), stderr: '' };
}

export function fail(stderr: string, exitCode = 1): CommandResult {
  return { exitCode, stdout: '', stderr: ensureTrailingNewline(stderr) };
}

export function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function formatTasks(tasks: KanbanTask[]): string {
  if (tasks.length === 0) {
    return 'No matching Keryx cards.\n';
  }

  return tasks
    .map((task) => [task.id, task.status ?? 'unknown', task.tenant ?? '', task.title ?? '(untitled)'].filter(Boolean).join('\t'))
    .join('\n') + '\n';
}

export function formatTaskShow(task: KanbanTask, bodyStatus: string): string {
  const lines = [
    `id: ${task.id}`,
    `title: ${task.title ?? '(untitled)'}`,
    `status: ${task.status ?? 'unknown'}`,
    `source: ${task.tenant ?? '(none)'}`,
    `action body: ${bodyStatus}`,
  ];
  return `${lines.join('\n')}\n`;
}

export function formatCronJobs(jobs: CronJobSummary[]): string {
  if (jobs.length === 0) {
    return 'No keryx-* cron jobs found.\n';
  }

  return jobs
    .map((job) => `${job.enabled ? 'enabled' : 'disabled'}\t${job.name}${job.schedule ? `\t${job.schedule}` : ''}`)
    .join('\n') + '\n';
}

export function formatDeliveryTargets(targets: DeliveryTarget[]): string {
  if (targets.length === 0) {
    return 'No delivery targets found.\n';
  }

  return targets.map((target) => [target.target, target.platform ?? '', target.label ?? ''].filter(Boolean).join('\t')).join('\n') + '\n';
}

export function formatValidationErrors(errors: ValidationError[]): string {
  return errors.map((error) => `${error.path || '/'} ${error.message}`).join('\n');
}

export function formatDoctorLines(lines: DoctorLine[]): string {
  return lines.map((line) => `${line.level} ${line.check}: ${line.message}`).join('\n') + '\n';
}

function ensureTrailingNewline(value: string): string {
  return value.endsWith('\n') ? value : `${value}\n`;
}
