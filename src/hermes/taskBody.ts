import { formatValidationErrors } from '../opsctl/output';
import { type ActionItem, validateActionItem } from '../schemas/actionItem';
import type { KanbanTask } from './types';

export function parseActionItemFromTask(task: KanbanTask): { ok: true; actionItem: ActionItem } | { ok: false; message: string } {
  if (typeof task.body !== 'string') {
    return { ok: false, message: 'task body is not a JSON string' };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(task.body) as unknown;
  } catch (error) {
    return {
      ok: false,
      message: `task body is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const validation = validateActionItem(parsed);
  if (!validation.ok) {
    return { ok: false, message: formatValidationErrors(validation.errors) };
  }

  return { ok: true, actionItem: validation.value };
}

export function taskStatus(task: KanbanTask): string {
  return typeof task.status === 'string' && task.status.trim().length > 0 ? task.status : 'unknown';
}

export function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}
