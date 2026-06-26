// Per-class track-record aggregator (PRD §7.7 / §7.9, D7).
//
// Rebuilds the confidence track record straight from the Kanban audit trail — no
// second store. For each task whose body is a valid keryx.action_item.v2 card, the
// card's `class` is the bucket; its comments are scanned for the three machine
// comment kinds and tallied:
//   - execution_decision -> approved, unless the selected option differs from the
//     card's ui.primary_option_id (an override).
//   - dismissal_decision -> dismissed.
//   - regret             -> regret.
// The resulting { approved, overridden, dismissed, regret } feeds deriveBand().

import type { KanbanComment, KanbanTask } from '../hermes/types';
import type { TrackRecord } from './confidence';
import { validateActionItem } from '../schemas/actionItem';
import { validateDismissalDecision } from '../schemas/dismissalDecision';
import { validateExecutionDecision } from '../schemas/executionDecision';
import { validateRegret } from '../schemas/regret';

function emptyRecord(): TrackRecord {
  return { approved: 0, overridden: 0, dismissed: 0, regret: 0 };
}

function parseCommentBody(comment: KanbanComment): unknown {
  if (typeof comment.body !== 'string') return null;
  try {
    return JSON.parse(comment.body) as unknown;
  } catch {
    return null;
  }
}

export function aggregateTrackRecord(tasks: KanbanTask[]): Record<string, TrackRecord> {
  const records: Record<string, TrackRecord> = {};

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

    const cls = card.value.class;
    const primaryOptionId = card.value.ui?.primary_option_id ?? null;
    const record = (records[cls] ??= emptyRecord());

    for (const comment of task.comments ?? []) {
      const body = parseCommentBody(comment);
      if (body === null) continue;

      const decision = validateExecutionDecision(body);
      if (decision.ok) {
        // An "override" is a decision whose selected option differs from the card's
        // recommendation. With no declared primary, any approval counts as approved.
        if (primaryOptionId !== null && decision.value.selected_option_id !== primaryOptionId) {
          record.overridden += 1;
        } else {
          record.approved += 1;
        }
        continue;
      }

      if (validateDismissalDecision(body).ok) {
        record.dismissed += 1;
        continue;
      }

      if (validateRegret(body).ok) {
        record.regret += 1;
      }
    }
  }

  return records;
}
