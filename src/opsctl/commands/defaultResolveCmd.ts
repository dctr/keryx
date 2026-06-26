// defaultResolveCmd: the expiring-default resolver for interrupt cards past their deadline.

import { HermesCliAdapter } from '../../hermes/adapter';
import { buildAutoResolutionOutcome, DEFAULT_RESOLVER_ACTOR, findResolvableInterrupts, resolveDefaultOption } from '../defaultResolver';
import type { ActionItem } from '../../schemas/actionItem';
import type { CommandResult } from '../output';
import { json, ok } from '../output';
import type { ParsedArgs } from '../shared';

// The trusted execution decision the resolver writes when auto-executing a default option.
// approved_by/_via name the resolver (not "User") so the audit trail makes clear the
// timeout default fired, not a human approval.
function buildAutoResolutionDecision(selectedOptionId: string, now: () => Date) {
  return {
    schema: 'keryx.execution_decision.v1',
    selected_option_id: selectedOptionId,
    user_feedback: null,
    approved_by: DEFAULT_RESOLVER_ACTOR,
    approved_via: DEFAULT_RESOLVER_ACTOR,
    approved_at: now().toISOString(),
  };
}

// The exact-item dismissal the resolver writes when auto-dismissing an unanswered
// interrupt. dismissed_by/_via name the resolver so the dismissal is attributable to the
// timeout default rather than a human action.
function buildAutoResolutionDismissal(actionItem: ActionItem, now: () => Date) {
  return {
    schema: 'keryx.dismissal_decision.v1',
    dismissal_scope: 'exact_item',
    reason: 'Auto-dismissed on interrupt timeout: no decision before default_on_timeout deadline.',
    dismissed_external_id: actionItem.external_id,
    dismissed_idempotency_key: actionItem.idempotency_key,
    dismissed_by: DEFAULT_RESOLVER_ACTOR,
    dismissed_via: DEFAULT_RESOLVER_ACTOR,
    dismissed_at: now().toISOString(),
  };
}

// `default-resolve [--preview]` (PRD §7.5, §10.6): the expiring-default resolver. Lists
// the board once, selects interrupt cards whose default_on_timeout deadline has passed
// with no human decision (and no prior auto-resolution), and executes each card's default
// — auto-executing the referenced option (record an execution decision + outcome, promote
// to ready) or auto-dismissing it (record a dismissal + outcome, archive). Every
// resolution writes a log_only keryx.outcome.v1 tagged delivered_via=keryx-default-resolver
// so a re-run never double-resolves and the digest can report it. --preview only plans.
export async function defaultResolveCmd(parsed: ParsedArgs, adapter: HermesCliAdapter, now: () => Date): Promise<CommandResult> {
  const preview = parsed.flags.get('preview') === true;
  const tasks = await adapter.listTasksWithComments();
  const resolvable = findResolvableInterrupts(tasks, now());

  const resolved: Array<Record<string, unknown>> = [];
  for (const item of resolvable) {
    if (item.timeout.action === 'execute_option') {
      const option = resolveDefaultOption(item);
      if (!option) {
        // A valid interrupt card always has a resolvable option; skip defensively rather
        // than mis-fire if a malformed default slipped past schema validation.
        continue;
      }
      if (preview) {
        resolved.push({ task_id: item.task.id, action: 'execute_option', option_id: option.id, status: 'planned' });
        continue;
      }
      await adapter.commentTask(item.task.id, JSON.stringify(buildAutoResolutionOutcome(item, now)));
      await adapter.commentTask(item.task.id, JSON.stringify(buildAutoResolutionDecision(option.id, now)));
      await adapter.promoteTask(item.task.id, 'auto-resolved by Keryx default-resolver');
      resolved.push({ task_id: item.task.id, action: 'execute_option', option_id: option.id, status: 'ready' });
      continue;
    }

    if (preview) {
      resolved.push({ task_id: item.task.id, action: 'dismiss', status: 'planned' });
      continue;
    }
    await adapter.commentTask(item.task.id, JSON.stringify(buildAutoResolutionOutcome(item, now)));
    await adapter.commentTask(item.task.id, JSON.stringify(buildAutoResolutionDismissal(item.card, now)));
    await adapter.archiveTask(item.task.id);
    resolved.push({ task_id: item.task.id, action: 'dismiss', status: 'archived' });
  }

  return ok(json({ ok: true, preview, resolved }));
}
