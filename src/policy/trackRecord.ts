// Per-(collector, class) track-record aggregator (PRD §7.7 / §7.9, D7).
//
// Rebuilds confidence straight from the Kanban audit trail — no second store. For
// each task whose body is a valid keryx.action_item.v2 card, the card's
// `(collector, class)` pair is the bucket; its comments are scanned for machine
// comment kinds. Dismissals/regrets are reset events: approvals/overrides are counted
// only after the latest reset event for the bucket, while dismissed/regret totals stay
// all-time for display/metrics:
//   - execution_decision -> approved, unless the selected option differs from the
//     card's ui.primary_option_id (an override).
//   - dismissal_decision -> dismissed + reset.
//   - regret             -> regret + reset.
// The resulting { approved, overridden, dismissed, regret } feeds deriveBand().

import type { KanbanTask } from '../hermes/types';
import type { TrackRecord } from './confidence';
import { parseCommentBody } from '../hermes/commentBody';
import { validateActionItem } from '../schemas/actionItem';
import { validateDismissalDecision } from '../schemas/dismissalDecision';
import { validateExecutionDecision } from '../schemas/executionDecision';
import { validateRegret } from '../schemas/regret';
import { validatorForSchema } from '../schemas/validatorBySchema';

const KEY_SEPARATOR = '\u0000';

export function trackRecordKey(collector: string, cls: string): string {
  return `${collector}${KEY_SEPARATOR}${cls}`;
}

export function splitTrackRecordKey(key: string): { collector: string; class: string } {
  const index = key.indexOf(KEY_SEPARATOR);
  if (index === -1) return { collector: '', class: key };
  return {
    collector: key.slice(0, index),
    class: key.slice(index + KEY_SEPARATOR.length),
  };
}

type TrackEvent = {
  kind: 'approved' | 'overridden' | 'reset';
  timestamp?: number;
  sequence: number;
};

interface WorkingTrackRecord {
  events: TrackEvent[];
  dismissed: number;
  regret: number;
}

function emptyWorkingRecord(): WorkingTrackRecord {
  return { events: [], dismissed: 0, regret: 0 };
}

function parseTimestamp(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    // Kanban payloads usually emit Unix seconds, but some adapters use ms.
    return value > 1_000_000_000_000 ? value : value * 1000;
  }
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function eventTimestamp(task: KanbanTask, comment: { created_at?: unknown }): number | undefined {
  return (
    parseTimestamp(comment.created_at) ??
    parseTimestamp((task as { updated_at?: unknown }).updated_at) ??
    parseTimestamp((task as { created_at?: unknown }).created_at)
  );
}

export function aggregateTrackRecord(tasks: KanbanTask[]): Record<string, TrackRecord> {
  const working: Record<string, WorkingTrackRecord> = {};
  let sequence = 0;

  const ensureRecord = (key: string): WorkingTrackRecord => {
    const current = working[key];
    if (current) return current;
    const created = emptyWorkingRecord();
    working[key] = created;
    return created;
  };

  const pushApprovalEvent = (record: WorkingTrackRecord, kind: 'approved' | 'overridden', timestamp?: number): void => {
    record.events.push({ kind, timestamp, sequence: sequence++ });
  };

  const pushResetEvent = (record: WorkingTrackRecord, timestamp?: number): void => {
    record.events.push({ kind: 'reset', timestamp, sequence: sequence++ });
  };

  for (const task of tasks) {
    if (typeof task.body !== 'string') continue;

    let parsedBody: unknown;
    try {
      parsedBody = JSON.parse(task.body) as unknown;
    } catch {
      continue;
    }

    const card = validateActionItem(parsedBody);
    if (!card.ok) continue;

    const key = trackRecordKey(card.value.collector, card.value.class);
    const primaryOptionId = card.value.ui?.primary_option_id ?? null;
    const record = ensureRecord(key);

    for (const comment of task.comments ?? []) {
      const body = parseCommentBody(comment);
      if (body === null) continue;
      const timestamp = eventTimestamp(task, comment);

      // Fast path: dispatch on the body's schema field when present.
      const fastValidator = validatorForSchema(body);
      if (fastValidator !== null) {
        if (!fastValidator(body).ok) continue;
        const schemaKey = (body as Record<string, unknown>)['schema'] as string;
        if (schemaKey === 'keryx.execution_decision.v1') {
          const decision = validateExecutionDecision(body);
          if (decision.ok) {
            if (primaryOptionId !== null && decision.value.selected_option_id !== primaryOptionId) {
              pushApprovalEvent(record, 'overridden', timestamp);
            } else {
              pushApprovalEvent(record, 'approved', timestamp);
            }
          }
        } else if (schemaKey === 'keryx.dismissal_decision.v1') {
          record.dismissed += 1;
          pushResetEvent(record, timestamp);
        } else if (schemaKey === 'keryx.regret.v1') {
          record.regret += 1;
          pushResetEvent(record, timestamp);
        }
        // other known schemas (outcome, policy_decision) are not tracked here — skip.
        continue;
      }

      // Slow path: no schema field — try each validator in sequence.
      const decision = validateExecutionDecision(body);
      if (decision.ok) {
        // An "override" is a decision whose selected option differs from the card's
        // recommendation. With no declared primary, any approval counts as approved.
        if (primaryOptionId !== null && decision.value.selected_option_id !== primaryOptionId) {
          pushApprovalEvent(record, 'overridden', timestamp);
        } else {
          pushApprovalEvent(record, 'approved', timestamp);
        }
        continue;
      }

      if (validateDismissalDecision(body).ok) {
        record.dismissed += 1;
        pushResetEvent(record, timestamp);
        continue;
      }

      if (validateRegret(body).ok) {
        record.regret += 1;
        pushResetEvent(record, timestamp);
      }
    }
  }

  const records: Record<string, TrackRecord> = {};
  for (const [key, record] of Object.entries(working)) {
    const orderedEvents = [...record.events].sort((a, b) => {
      if (a.timestamp !== undefined && b.timestamp !== undefined && a.timestamp !== b.timestamp) {
        return a.timestamp - b.timestamp;
      }
      return a.sequence - b.sequence;
    });
    let latestResetIndex = -1;
    for (let index = 0; index < orderedEvents.length; index += 1) {
      if (orderedEvents[index]?.kind === 'reset') {
        latestResetIndex = index;
      }
    }

    let approved = 0;
    let overridden = 0;
    for (let index = 0; index < orderedEvents.length; index += 1) {
      if (index <= latestResetIndex) continue;
      const event = orderedEvents[index];
      if (event.kind === 'approved') {
        approved += 1;
      } else if (event.kind === 'overridden') {
        overridden += 1;
      }
    }

    records[key] = {
      approved,
      overridden,
      dismissed: record.dismissed,
      regret: record.regret,
    };
  }

  return records;
}
