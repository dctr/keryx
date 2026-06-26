// Interrupt composer + delivery gate (PRD §7.5, §9.2). Pure helpers that turn an
// interrupt-tier card into a self-contained push message, decide whether the push is
// allowed right now (notify_target configured, quiet-hours window, per-tier daily
// budget), and build the keryx.notification.v1 audit/dedupe comment. The command layer
// (commands.ts) wires these to adapter.sendMessage + adapter.commentTask; nothing here
// performs a side effect, so every branch is table-testable.

import type { ActionItem, Urgency } from '../schemas/actionItem';
import type { InterruptBudget, QuietHours } from '../config';
import type { Notification } from '../schemas/notification';
import type { KanbanTask } from '../hermes/types';
import { validateNotification } from '../schemas/notification';

// Budget is keyed by urgency tier (matches keryx.config interruptBudget.perTierPerDay):
// an urgent card counts against 'urgent'; everything else against 'soon'.
export type InterruptTier = 'urgent' | 'soon';

export function interruptTier(urgency: Urgency): InterruptTier {
  return urgency === 'urgent' ? 'urgent' : 'soon';
}

// Per-card dedupe + per-tier budget counting both key off this stable shape, so the
// tier is recoverable from the comment alone (the notification schema carries no tier).
export function interruptDedupeKey(taskId: string, tier: InterruptTier): string {
  return `keryx:interrupt:${tier}:${taskId}`;
}

export interface ComposeInterruptInput {
  taskId: string;
  card: ActionItem;
  // One-line "why", typically disposition.reasons joined; the card never trusts itself
  // to upgrade, so the reason comes from the deterministic disposition function.
  reason: string;
}

// Composes the exact PRD §9.2 self-contained interrupt message. Deep link is the
// hash-router path /#/card/<id> so the dashboard opens straight to the card.
export function composeInterruptMessage(input: ComposeInterruptInput): string {
  const { card, taskId, reason } = input;
  return [
    `Urgent: ${card.title}`,
    `Why: ${oneLine(reason) || 'No reason recorded.'}`,
    `Risk if wrong: ${oneLine(card.risk ?? '') || 'Not specified.'}`,
    `Default if no reply${defaultClause(card)}`,
    `Open in Keryx: /#/card/${taskId}`,
    'Reply: approve / change / hold',
  ].join('\n');
}

function defaultClause(card: ActionItem): string {
  const timeout = card.default_on_timeout;
  if (!timeout) {
    return ': none set.';
  }
  const by = timeout.after ? ` by ${timeout.after}` : '';
  if (timeout.action === 'dismiss') {
    return `${by}: dismiss this card.`;
  }
  const option = card.options.find((candidate) => candidate.id === timeout.option_id);
  const label = option?.label ?? timeout.option_id ?? 'the default option';
  return `${by}: ${label}.`;
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

export interface InterruptDeliveryInput {
  notifyTarget?: string;
  urgency: Urgency;
  quietHours?: QuietHours;
  budget?: InterruptBudget;
  // How many interrupts of this tier were already pushed today (board-wide).
  sentTodayForTier: number;
  now: Date;
}

export interface InterruptDeliveryDecision {
  deliver: boolean;
  reason: string;
}

// Decides whether an interrupt push goes out right now (PRD §7.5). Order: a configured
// notify_target is required; quiet hours suppress everything but tier-5 (urgent); the
// per-tier daily budget caps the rest. Anything suppressed falls back to the digest.
export function decideInterruptDelivery(input: InterruptDeliveryInput): InterruptDeliveryDecision {
  if (!input.notifyTarget) {
    return { deliver: false, reason: 'no notify_target configured -> falls back to digest' };
  }

  const isUrgent = input.urgency === 'urgent';
  if (input.quietHours && isWithinQuietHours(input.now, input.quietHours) && !isUrgent) {
    return { deliver: false, reason: 'within quiet hours; only urgent interrupts are delivered' };
  }

  const tier = interruptTier(input.urgency);
  const cap = input.budget?.perTierPerDay[tier];
  if (cap !== undefined && input.sentTodayForTier >= cap) {
    return {
      deliver: false,
      reason: `interrupt budget for ${tier} exhausted (${input.sentTodayForTier}/${cap}) -> falls back to digest`,
    };
  }

  return { deliver: true, reason: 'within quiet-hours and budget policy' };
}

// Wall-clock quiet-hours test using the local time of `now`. Handles a window that
// wraps midnight (e.g. 22:00–07:00). Boundaries: start is inclusive, end exclusive.
export function isWithinQuietHours(now: Date, quietHours: QuietHours): boolean {
  const minutesNow = now.getHours() * 60 + now.getMinutes();
  const start = toMinutes(quietHours.start);
  const end = toMinutes(quietHours.end);
  if (start === end) {
    return false;
  }
  if (start < end) {
    return minutesNow >= start && minutesNow < end;
  }
  // Wrap-around window: active from start until midnight, then midnight until end.
  return minutesNow >= start || minutesNow < end;
}

function toMinutes(hhmm: string): number {
  const [hours, minutes] = hhmm.split(':').map((part) => Number.parseInt(part, 10));
  return hours * 60 + minutes;
}

export interface BuildNotificationInput {
  channel: 'interrupt' | 'digest';
  target: string;
  dedupeKey: string;
  now: Date;
}

// Builds (and re-validates) the keryx.notification.v1 audit comment a push appends.
export function buildNotification(input: BuildNotificationInput): Notification {
  const notification: Notification = {
    schema: 'keryx.notification.v1',
    channel: input.channel,
    target: input.target,
    sent_at: input.now.toISOString(),
    dedupe_key: input.dedupeKey,
  };
  const validation = validateNotification(notification);
  if (!validation.ok) {
    throw new Error(`generated notification is invalid: ${validation.errors.map((error) => error.message).join(', ')}`);
  }
  return validation.value;
}

// True when a card already carries an interrupt notification with this dedupe key, so a
// push is sent at most once per card even across re-runs (PRD §7.5).
export function hasInterruptNotification(task: KanbanTask, dedupeKey: string): boolean {
  return readNotifications(task).some((notification) => notification.dedupe_key === dedupeKey);
}

// Counts interrupt notifications of a given tier pushed on the same calendar day as
// `now` (local), across the supplied board tasks — the per-tier daily budget denominator.
export function countInterruptsSentToday(tasks: KanbanTask[], tier: InterruptTier, now: Date): number {
  const prefix = `keryx:interrupt:${tier}:`;
  let count = 0;
  for (const task of tasks) {
    for (const notification of readNotifications(task)) {
      if (notification.channel !== 'interrupt') continue;
      if (!notification.dedupe_key.startsWith(prefix)) continue;
      if (sameLocalDay(new Date(notification.sent_at), now)) {
        count += 1;
      }
    }
  }
  return count;
}

function readNotifications(task: KanbanTask): Notification[] {
  const notifications: Notification[] = [];
  for (const comment of task.comments ?? []) {
    if (typeof comment.body !== 'string') continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(comment.body);
    } catch {
      continue;
    }
    const validation = validateNotification(parsed);
    if (validation.ok) {
      notifications.push(validation.value);
    }
  }
  return notifications;
}

function sameLocalDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}
