import type { Autonomy } from '../../schemas/actionItem';
import type { TaskCardView } from './taskView';
import { sortTaskViews } from './taskView';

export type TaskViewKey = 'inbox' | 'running' | 'completed' | 'dismissed';
export type SourceFilter = 'all' | string;
export type AutonomyFilter = 'all' | Autonomy;

export interface TaskFilters {
  view: TaskViewKey;
  source: SourceFilter;
  autonomy: AutonomyFilter;
  urgentOnly: boolean;
}

export const viewOptions: Array<{ key: TaskViewKey; label: string; statuses: string[] }> = [
  { key: 'inbox', label: 'Inbox', statuses: ['blocked', 'todo'] },
  { key: 'running', label: 'Running', statuses: ['ready', 'running'] },
  { key: 'completed', label: 'Completed', statuses: ['done'] },
  { key: 'dismissed', label: 'Dismissed', statuses: ['archived'] },
];

export const autonomyOptions: Array<{ value: AutonomyFilter; label: string }> = [
  { value: 'all', label: 'All autonomy' },
  { value: 'auto', label: 'Auto' },
  { value: 'minimal', label: 'Needs input' },
  { value: 'research', label: 'Research' },
  { value: 'complex', label: 'Complex' },
];

export function applyTaskFilters(tasks: TaskCardView[], filters: TaskFilters): TaskCardView[] {
  return sortTaskViews(
    tasks.filter((task) => {
      if (!taskMatchesView(task, filters.view)) {
        return false;
      }
      if (filters.source !== 'all' && task.source !== filters.source) {
        return false;
      }
      if (filters.autonomy !== 'all' && task.autonomy !== filters.autonomy) {
        return false;
      }
      if (filters.urgentOnly && !isUrgentOrDeadlineSoon(task)) {
        return false;
      }
      return true;
    }),
  );
}

export function taskMatchesView(task: TaskCardView, view: TaskViewKey): boolean {
  const statuses = viewOptions.find((option) => option.key === view)?.statuses ?? [];
  return statuses.includes(task.status);
}

export function countTasksForView(tasks: TaskCardView[], view: TaskViewKey): number {
  return tasks.filter((task) => taskMatchesView(task, view)).length;
}

export function isUrgentOrDeadlineSoon(task: TaskCardView, nowMs = Date.now()): boolean {
  if (task.urgency === 'urgent' || task.urgency === 'soon') {
    return true;
  }
  if (task.deadlineMs === null) {
    return false;
  }
  const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
  return task.deadlineMs >= nowMs && task.deadlineMs - nowMs <= sevenDaysMs;
}
