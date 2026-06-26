// Expiring-default resolver (PRD §7.5, §10.6). Pure helpers + a command-layer step that
// executes a card's default_on_timeout once an unanswered interrupt's deadline passes —
// preventing the "stuck for 119 minutes awaiting a 15-second decision" failure (S14).
//
// Discipline mirrors digest.ts: nothing here performs a side effect. The helpers select
// expired/undecided interrupt cards, resolve a deadline deterministically, and build the
// validated keryx.outcome.v1 the resolution records. commands.ts wires these to the
// adapter (comment the auto-decision + outcome, then promote or archive).

import type { ActionItem, ActionOption, DefaultOnTimeout } from '../schemas/actionItem';
import type { KanbanTask } from '../hermes/types';
import type { Outcome } from '../schemas/outcome';
import { parseCommentBody } from '../hermes/commentBody';
import { validateActionItem } from '../schemas/actionItem';
import { validateDismissalDecision } from '../schemas/dismissalDecision';
import { validateExecutionDecision } from '../schemas/executionDecision';
import { validateOutcome } from '../schemas/outcome';

// The resolver tags everything it writes with this marker so a second run never
// double-resolves the same card (the outcome's delivered_via field carries it).
export const DEFAULT_RESOLVER_ACTOR = 'keryx-default-resolver';

// A card whose interrupt default is past due and still awaiting a human decision.
export interface ResolvableInterrupt {
  task: KanbanTask;
  card: ActionItem;
  timeout: DefaultOnTimeout;
  deadline: Date;
}

// Resolves a default_on_timeout `after` value into an absolute deadline, deterministically
// or not at all. Two forms are honoured (PRD §10.6): an ISO-8601 duration (e.g. PT2H, P1D),
// resolved relative to the card's created_at; or an absolute ISO-8601 timestamp. A bare
// wall-clock time ("15:00") is display-only — it has no date and the resolver refuses to
// guess one — so it returns null and the card is left for a human rather than mis-fired.
export function resolveTimeoutDeadline(after: string, createdAt: string): Date | null {
  const trimmed = after.trim();
  if (trimmed.length === 0) {
    return null;
  }

  const durationMs = parseIso8601DurationMs(trimmed);
  if (durationMs !== null) {
    const base = Date.parse(createdAt);
    return Number.isFinite(base) ? new Date(base + durationMs) : null;
  }

  if (isAbsoluteTimestamp(trimmed)) {
    const at = Date.parse(trimmed);
    return Number.isFinite(at) ? new Date(at) : null;
  }

  return null;
}

// Selects interrupt cards whose default has expired and which carry no human decision and
// no prior auto-resolution. Source content is never trusted: only a schema-valid v2 body
// with proposed_disposition=interrupt and a resolvable deadline qualifies.
export function findResolvableInterrupts(tasks: KanbanTask[], now: Date): ResolvableInterrupt[] {
  const resolvable: ResolvableInterrupt[] = [];

  for (const task of tasks) {
    const card = parseInterruptCard(task);
    if (!card) {
      continue;
    }

    const timeout = card.default_on_timeout;
    if (!timeout) {
      continue;
    }

    const deadline = resolveTimeoutDeadline(timeout.after, card.created_at);
    if (!deadline || deadline.getTime() > now.getTime()) {
      continue;
    }

    if (hasHumanDecision(task) || hasAutoResolution(task)) {
      continue;
    }

    resolvable.push({ task, card, timeout, deadline });
  }

  return resolvable;
}

// Builds the keryx.outcome.v1 comment recording an auto-resolution. It is always
// result_delivery=log_only (the user pulls it from the review log / next digest reports
// the dismissal) and tagged delivered_via=keryx-default-resolver for dedupe and audit.
export function buildAutoResolutionOutcome(item: ResolvableInterrupt, now: () => Date = () => new Date()): Outcome {
  const { card, timeout } = item;
  const executedOptionId = timeout.action === 'execute_option' ? (timeout.option_id ?? '') : 'dismiss';
  const option = card.options.find((candidate) => candidate.id === executedOptionId);

  const outcome: Outcome = {
    schema: 'keryx.outcome.v1',
    executed_option_id: executedOptionId,
    result_summary:
      timeout.action === 'execute_option'
        ? `Auto-resolved on interrupt timeout: executed default option "${option?.label ?? executedOptionId}".`
        : 'Auto-resolved on interrupt timeout: dismissed the unanswered interrupt.',
    result_delivery: 'log_only',
    digest_category: null,
    changed_state:
      timeout.action === 'execute_option'
        ? `auto-executed default option ${executedOptionId}; card promoted to ready`
        : 'auto-dismissed unanswered interrupt; card archived',
    delivered_via: DEFAULT_RESOLVER_ACTOR,
    completed_at: now().toISOString(),
  };

  const validation = validateOutcome(outcome);
  if (!validation.ok) {
    throw new Error(`generated auto-resolution outcome is invalid: ${validation.errors.map((error) => error.message).join(', ')}`);
  }
  return validation.value;
}

// Looks up the option the execute_option default references; null when it cannot be
// resolved (the schema cross-validation should prevent this on a valid interrupt card).
export function resolveDefaultOption(item: ResolvableInterrupt): ActionOption | null {
  if (item.timeout.action !== 'execute_option' || !item.timeout.option_id) {
    return null;
  }
  return item.card.options.find((option) => option.id === item.timeout.option_id) ?? null;
}

function parseInterruptCard(task: KanbanTask): ActionItem | null {
  if (typeof task.body !== 'string') {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(task.body) as unknown;
  } catch {
    return null;
  }
  const validation = validateActionItem(parsed);
  if (!validation.ok || validation.value.proposed_disposition !== 'interrupt') {
    return null;
  }
  return validation.value;
}

// A human already decided this card if it carries a trusted execution-decision or
// dismissal-decision comment. (A policy_decision is a machine record, not a human reply.)
function hasHumanDecision(task: KanbanTask): boolean {
  return someComment(task, (body) => validateExecutionDecision(body).ok || validateDismissalDecision(body).ok);
}

// True when this card already carries a resolver-authored outcome — so re-running the
// resolver (it is a scheduled step) never auto-resolves the same card twice.
function hasAutoResolution(task: KanbanTask): boolean {
  return someComment(task, (body) => {
    const outcome = validateOutcome(body);
    return outcome.ok && outcome.value.delivered_via === DEFAULT_RESOLVER_ACTOR;
  });
}

function someComment(task: KanbanTask, predicate: (body: unknown) => boolean): boolean {
  for (const comment of task.comments ?? []) {
    const body = parseCommentBody(comment);
    if (body !== null && predicate(body)) {
      return true;
    }
  }
  return false;
}

// Parses a (subset of) ISO-8601 duration into milliseconds. Supports the date/time forms
// Keryx uses for expiring defaults: weeks (PnW), and days/hours/minutes/seconds
// (PnDTnHnMnS). Months and years are intentionally rejected (no fixed ms length, would
// require a calendar). Returns null when the string is not a well-formed duration with at
// least one component, so the caller can fall back to absolute-timestamp parsing.
export function parseIso8601DurationMs(value: string): number | null {
  const weekMatch = value.match(/^P(\d+)W$/);
  if (weekMatch) {
    return Number.parseInt(weekMatch[1], 10) * 7 * 24 * 60 * 60 * 1000;
  }

  const match = value.match(/^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/);
  if (!match) {
    return null;
  }
  const [, days, hours, minutes, seconds] = match;
  if (!days && !hours && !minutes && !seconds) {
    return null;
  }

  return (
    toInt(days) * 24 * 60 * 60 * 1000 +
    toInt(hours) * 60 * 60 * 1000 +
    toInt(minutes) * 60 * 1000 +
    toInt(seconds) * 1000
  );
}

function isAbsoluteTimestamp(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value);
}

function toInt(value: string | undefined): number {
  return value ? Number.parseInt(value, 10) : 0;
}
