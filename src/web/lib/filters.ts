import type { TaskCardView } from './taskView';
import { sortTaskViews } from './taskView';

export type TaskViewKey = 'needsYou' | 'running' | 'reviewLog' | 'dismissed';
export type SourceFilter = 'all' | string;

export interface TaskFilters {
  view: TaskViewKey;
  source: SourceFilter;
  urgentOnly: boolean;
}

// Lanes follow the v005 disposition model: cards needing the user (blocked/todo),
// cards in flight (ready/running), the read-only review log of finished cards
// (done — silent outcomes and human-approved executions land here), and dismissals.
export const viewOptions: Array<{ key: TaskViewKey; label: string; statuses: string[] }> = [
  { key: 'needsYou', label: 'Needs you', statuses: ['blocked', 'todo'] },
  { key: 'running', label: 'Running', statuses: ['ready', 'running'] },
  { key: 'reviewLog', label: 'Review log', statuses: ['done'] },
  { key: 'dismissed', label: 'Dismissed', statuses: ['archived'] },
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
