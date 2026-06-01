import type { ActionItem, ActionOption, Autonomy, Urgency } from '../../schemas/actionItem';
import type { ApiTask, MalformedTaskError } from './api';

export interface TaskCardView {
  id: string;
  title: string;
  status: string;
  statusLabel: string;
  statusTone: 'attention' | 'queued' | 'active' | 'done' | 'muted';
  source: string;
  sourceLabel: string;
  collector: string | null;
  autonomy: Autonomy;
  autonomyLabel: string;
  urgency: Urgency;
  urgencyLabel: string;
  urgencyRank: number;
  deadline: string | null;
  deadlineLabel: string;
  deadlineMs: number | null;
  origin: string;
  summary: string;
  risk: string | null;
  options: ActionOption[];
  primaryOption: ActionOption | null;
  displayGroup: string | null;
  createdAtMs: number;
}

export interface MalformedTaskView {
  id: string;
  title: string;
  status: string;
  statusLabel: string;
  malformed: true;
  summary: string;
}

const STATUS_LABELS: Record<string, string> = {
  blocked: 'Needs User',
  todo: 'Needs User',
  ready: 'Queued',
  running: 'Running',
  done: 'Completed',
  archived: 'Dismissed',
  scheduled: 'Scheduled',
  review: 'In review',
};

const URGENCY_LABELS: Record<Urgency, string> = {
  low: 'Low',
  normal: 'Normal',
  soon: 'Soon',
  urgent: 'Urgent',
};

const URGENCY_RANKS: Record<Urgency, number> = {
  low: 1,
  normal: 2,
  soon: 3,
  urgent: 4,
};

const AUTONOMY_LABELS: Record<Autonomy, string> = {
  auto: 'Auto',
  minimal: 'Needs input',
  research: 'Research',
  complex: 'Complex',
};

export function mapTaskToView(task: ApiTask): TaskCardView {
  const item = task.action_item;
  const status = normaliseStatus(task.status);
  const deadlineMs = parseDate(item.deadline);
  const primaryOption = primaryOptionFor(item);

  return {
    id: task.id,
    title: item.title || task.title || task.id,
    status,
    statusLabel: statusLabelFor(status),
    statusTone: statusToneFor(status),
    source: item.source,
    sourceLabel: sourceLabel(item.source),
    collector: task.created_by,
    autonomy: item.autonomy,
    autonomyLabel: autonomyLabelFor(item.autonomy),
    urgency: item.urgency,
    urgencyLabel: urgencyLabelFor(item.urgency),
    urgencyRank: URGENCY_RANKS[item.urgency],
    deadline: item.deadline ?? null,
    deadlineLabel: deadlineLabelFor(item.deadline),
    deadlineMs,
    origin: item.origin_descriptor,
    summary: item.summary,
    risk: item.risk ?? null,
    options: item.options,
    primaryOption,
    displayGroup: item.ui?.display_group ?? null,
    createdAtMs: parseDate(item.created_at) ?? 0,
  };
}

export function mapMalformedTaskError(error: MalformedTaskError): MalformedTaskView {
  const status = normaliseStatus(error.status);
  return {
    id: error.task_id,
    title: error.title ?? error.task_id,
    status,
    statusLabel: statusLabelFor(status),
    malformed: true,
    summary: error.error,
  };
}

export function sortTaskViews(views: TaskCardView[]): TaskCardView[] {
  return [...views].sort((left, right) => {
    const urgency = right.urgencyRank - left.urgencyRank;
    if (urgency !== 0) {
      return urgency;
    }

    const leftDeadline = left.deadlineMs ?? Number.POSITIVE_INFINITY;
    const rightDeadline = right.deadlineMs ?? Number.POSITIVE_INFINITY;
    if (leftDeadline !== rightDeadline) {
      return leftDeadline - rightDeadline;
    }

    if (left.createdAtMs !== right.createdAtMs) {
      return right.createdAtMs - left.createdAtMs;
    }

    return left.title.localeCompare(right.title);
  });
}

export function statusLabelFor(status: string): string {
  const normalised = normaliseStatus(status);
  return STATUS_LABELS[normalised] ?? titleCase(normalised);
}

export function sourceLabel(source: string): string {
  return source
    .split(/[-_]/)
    .filter(Boolean)
    .map(titleCase)
    .join(' ');
}

export function autonomyLabelFor(autonomy: Autonomy): string {
  return AUTONOMY_LABELS[autonomy];
}

export function urgencyLabelFor(urgency: Urgency): string {
  return URGENCY_LABELS[urgency];
}

function primaryOptionFor(item: ActionItem): ActionOption | null {
  const preferred = item.ui?.primary_option_id;
  return item.options.find((option) => option.id === preferred) ?? item.options[0] ?? null;
}

function statusToneFor(status: string): TaskCardView['statusTone'] {
  if (status === 'blocked' || status === 'todo') {
    return 'attention';
  }
  if (status === 'ready') {
    return 'queued';
  }
  if (status === 'running') {
    return 'active';
  }
  if (status === 'done') {
    return 'done';
  }
  return 'muted';
}

function deadlineLabelFor(value: string | null | undefined): string {
  const timestamp = parseDate(value);
  if (timestamp === null) {
    return 'No deadline';
  }

  return new Intl.DateTimeFormat('en-AU', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(timestamp));
}

function normaliseStatus(status: string): string {
  return status.trim().toLowerCase();
}

function titleCase(value: string): string {
  return value.length > 0 ? `${value.slice(0, 1).toUpperCase()}${value.slice(1).toLowerCase()}` : value;
}

function parseDate(value: string | null | undefined): number | null {
  if (!value) {
    return null;
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}
