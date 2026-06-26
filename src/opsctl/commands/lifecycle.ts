// lifecycle command group: execute, dismiss, mark-reviewed.

import { HermesCliAdapter } from '../../hermes/adapter';
import { parseActionItemFromTask } from '../../hermes/taskBody';
import type { ActionItem } from '../../schemas/actionItem';
import type { CommandResult } from '../output';
import { fail, json, ok } from '../output';
import { normaliseTaskStatus, type ParsedArgs, stringFlag, validateTaskIdArgument } from '../shared';

// ---------------------------------------------------------------------------
// Private builders
// ---------------------------------------------------------------------------

function buildExecutionDecision(selectedOptionId: string, userFeedback: string | null, now: () => Date) {
  return {
    schema: 'keryx.execution_decision.v1',
    selected_option_id: selectedOptionId,
    user_feedback: userFeedback,
    approved_by: 'User',
    approved_via: 'keryx-web',
    approved_at: now().toISOString(),
  };
}

function buildDismissalDecision(actionItem: ActionItem, reason: string | null, now: () => Date) {
  return {
    schema: 'keryx.dismissal_decision.v1',
    dismissal_scope: 'exact_item',
    reason,
    dismissed_external_id: actionItem.external_id,
    dismissed_idempotency_key: actionItem.idempotency_key,
    dismissed_by: 'User',
    dismissed_via: 'keryx-web',
    dismissed_at: now().toISOString(),
  };
}

function dismissResult(taskId: string, status: string, action: string, actionItem: ActionItem) {
  return {
    ok: true,
    task_id: taskId,
    status,
    action,
    dismissal_scope: 'exact_item',
    external_id: actionItem.external_id,
    idempotency_key: actionItem.idempotency_key,
  };
}

// ---------------------------------------------------------------------------
// execute
// ---------------------------------------------------------------------------

export async function executeCard(parsed: ParsedArgs, adapter: HermesCliAdapter, now: () => Date): Promise<CommandResult> {
  const taskId = parsed.positionals[0];
  if (!taskId) {
    return fail('FAIL execute requires a task id', 2);
  }

  const idError = validateTaskIdArgument(taskId);
  if (idError) {
    return idError;
  }

  const selectedOptionId = stringFlag(parsed, 'option');
  if (!selectedOptionId) {
    return fail('FAIL execute requires --option <option_id>', 2);
  }

  const task = await adapter.showTask(taskId);
  const body = parseActionItemFromTask(task);
  if (!body.ok) {
    return fail(`FAIL invalid action body for ${task.id}:\n${body.message}`);
  }

  const selectedOption = body.actionItem.options.find((option) => option.id === selectedOptionId);
  if (!selectedOption) {
    const availableOptions = body.actionItem.options.map((option) => option.id).join(', ') || '(none)';
    return fail(`FAIL invalid option ID ${selectedOptionId} for ${task.id}; available options: ${availableOptions}`);
  }

  const status = normaliseTaskStatus(task);
  if (status === 'ready' || status === 'running' || status === 'done') {
    return ok(
      json({
        ok: true,
        task_id: task.id,
        status,
        action: `already-${status}`,
        selected_option_id: selectedOption.id,
        dispatched: false,
      }),
    );
  }

  if (status !== 'blocked' && status !== 'todo') {
    return fail(`FAIL cannot execute ${task.id} from status ${status}`);
  }

  await adapter.commentTask(task.id, JSON.stringify(buildExecutionDecision(selectedOption.id, stringFlag(parsed, 'feedback') ?? null, now)));
  await adapter.promoteTask(task.id, 'approved from Keryx');

  const shouldDispatch = parsed.flags.get('dispatch') === true;
  if (shouldDispatch) {
    await adapter.dispatch();
  }

  return ok(
    json({
      ok: true,
      task_id: task.id,
      status: 'ready',
      action: 'promoted',
      selected_option_id: selectedOption.id,
      dispatched: shouldDispatch,
    }),
  );
}

// ---------------------------------------------------------------------------
// dismiss
// ---------------------------------------------------------------------------

export async function dismissCard(parsed: ParsedArgs, adapter: HermesCliAdapter, now: () => Date): Promise<CommandResult> {
  const taskId = parsed.positionals[0];
  if (!taskId) {
    return fail('FAIL dismiss requires a task id', 2);
  }

  const idError = validateTaskIdArgument(taskId);
  if (idError) {
    return idError;
  }

  const task = await adapter.showTask(taskId);
  const body = parseActionItemFromTask(task);
  if (!body.ok) {
    return fail(`FAIL invalid action body for ${task.id}:\n${body.message}`);
  }

  const status = normaliseTaskStatus(task);
  if (status === 'archived' || status === 'done') {
    return ok(json(dismissResult(task.id, status, `already-${status}`, body.actionItem)));
  }

  if (status !== 'blocked' && status !== 'todo') {
    return fail(`FAIL cannot dismiss ${task.id} from status ${status}`);
  }

  await adapter.commentTask(task.id, JSON.stringify(buildDismissalDecision(body.actionItem, stringFlag(parsed, 'reason') ?? null, now)));
  await adapter.archiveTask(task.id);

  return ok(json(dismissResult(task.id, 'archived', 'archived', body.actionItem)));
}

// ---------------------------------------------------------------------------
// mark-reviewed
// ---------------------------------------------------------------------------

// `mark-reviewed <task_id>` (PRD §7.10, §9): the review-log "Archive" action. A done card
// has already executed (its outcome stands); marking it reviewed simply acknowledges it and
// archives it out of the review log. It writes a `keryx:reviewed` marker comment, then
// archives. Unlike `dismiss`, which only acts on blocked/todo cards, this acts on `done`.
export async function markReviewedCard(parsed: ParsedArgs, adapter: HermesCliAdapter, now: () => Date): Promise<CommandResult> {
  const taskId = parsed.positionals[0];
  if (!taskId) {
    return fail('FAIL mark-reviewed requires a task id', 2);
  }

  const idError = validateTaskIdArgument(taskId);
  if (idError) {
    return idError;
  }

  const task = await adapter.showTask(taskId);
  const body = parseActionItemFromTask(task);
  if (!body.ok) {
    return fail(`FAIL invalid action body for ${task.id}:\n${body.message}`);
  }

  const status = normaliseTaskStatus(task);
  if (status === 'archived') {
    return ok(json({ ok: true, task_id: task.id, status, action: 'already-archived' }));
  }
  if (status !== 'done') {
    return fail(`FAIL cannot mark-reviewed ${task.id} from status ${status}; only done review-log cards are reviewable`);
  }

  await adapter.commentTask(task.id, JSON.stringify({ marker: 'keryx:reviewed', reviewed_by: 'User', reviewed_at: now().toISOString() }));
  await adapter.archiveTask(task.id);

  return ok(json({ ok: true, task_id: task.id, status: 'archived', action: 'reviewed' }));
}
