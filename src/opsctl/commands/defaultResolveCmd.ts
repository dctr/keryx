// defaultResolveCmd: the expiring-default resolver for interrupt cards past their deadline.

import { buildAutoResolutionOutcome, DEFAULT_RESOLVER_ACTOR, findResolvableInterrupts, resolveDefaultOption } from '../defaultResolver';
import type { CommandResult } from '../output';
import { json, ok } from '../output';
import { type CommandContext } from '../shared';
import { buildExecutionDecision, buildDismissalDecision } from '../builders';

// `default-resolve [--preview]` (PRD §7.5, §10.6): the expiring-default resolver. Lists
// the board once, selects interrupt cards whose default_on_timeout deadline has passed
// with no human decision (and no prior auto-resolution), and executes each card's default
// — auto-executing the referenced option (record an execution decision + outcome, promote
// to ready) or auto-dismissing it (record a dismissal + outcome, archive). Every
// resolution writes a log_only keryx.outcome.v1 tagged delivered_via=keryx-default-resolver
// so a re-run never double-resolves and the digest can report it. --preview only plans.
export async function defaultResolveCmd(ctx: CommandContext): Promise<CommandResult> {
  const { parsed, adapter, now } = ctx;
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
      await adapter.commentTask(
        item.task.id,
        JSON.stringify(
          buildExecutionDecision({
            selectedOptionId: option.id,
            userFeedback: null,
            approvedBy: DEFAULT_RESOLVER_ACTOR,
            approvedVia: DEFAULT_RESOLVER_ACTOR,
            now,
          }),
        ),
      );
      await adapter.promoteTask(item.task.id, 'auto-resolved by Keryx default-resolver');
      resolved.push({ task_id: item.task.id, action: 'execute_option', option_id: option.id, status: 'ready' });
      continue;
    }

    if (preview) {
      resolved.push({ task_id: item.task.id, action: 'dismiss', status: 'planned' });
      continue;
    }
    await adapter.commentTask(item.task.id, JSON.stringify(buildAutoResolutionOutcome(item, now)));
    await adapter.commentTask(
      item.task.id,
      JSON.stringify(
        buildDismissalDecision({
          actionItem: item.card,
          reason: 'Auto-dismissed on interrupt timeout: no decision before default_on_timeout deadline.',
          dismissedBy: DEFAULT_RESOLVER_ACTOR,
          dismissedVia: DEFAULT_RESOLVER_ACTOR,
          now,
        }),
      ),
    );
    await adapter.archiveTask(item.task.id);
    resolved.push({ task_id: item.task.id, action: 'dismiss', status: 'archived' });
  }

  return ok(json({ ok: true, preview, resolved }));
}
