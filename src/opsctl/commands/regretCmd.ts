// regretCmd: records an escalation-regret signal on a card (feeds confidence bands).

import { parseActionItemFromTask } from '../../hermes/taskBody';
import { validateRegret } from '../../schemas/regret';
import type { CommandResult } from '../output';
import { fail, formatValidationErrors, json, ok } from '../output';
import { buildCorrection } from '../builders';
import { type CommandContext, stringFlag, validateTaskIdArgument } from '../shared';

// `regret <task_id> --kind ...` (PRD §7.9): records a one-click escalation-regret signal
// as a validated keryx.regret.v1 comment on a card. This is the highest-severity feedback
// for confidence: a regret caps the class's band (see deriveBand) and can trigger demotion
// of an active rule. It only appends a comment — it never changes the card's status.
export async function regretCmd(ctx: CommandContext): Promise<CommandResult> {
  const { parsed, adapter, now } = ctx;
  const taskId = parsed.positionals[0];
  if (!taskId) {
    return fail('FAIL regret requires a task id', 2);
  }

  const idError = validateTaskIdArgument(taskId);
  if (idError) {
    return idError;
  }

  const kind = stringFlag(parsed, 'kind');
  if (kind !== 'should_have_acted' && kind !== 'should_have_asked') {
    return fail('FAIL regret --kind must be should_have_acted or should_have_asked', 2);
  }

  const note = stringFlag(parsed, 'note') ?? null;
  const regret = {
    schema: 'keryx.regret.v1' as const,
    kind,
    note,
    recorded_by: 'User',
    recorded_at: now().toISOString(),
  };

  // Re-validate against the schema before writing so a malformed comment can never reach
  // the audit trail (mirrors execute/dismiss building validated comment bodies).
  const validation = validateRegret(regret);
  if (!validation.ok) {
    return fail(`FAIL generated regret comment is invalid\n${formatValidationErrors(validation.errors)}`);
  }

  await adapter.commentTask(taskId, JSON.stringify(regret));

  if (note) {
    const task = await adapter.showTask(taskId);
    const body = parseActionItemFromTask(task);
    if (!body.ok) {
      return fail(`FAIL invalid action body for ${task.id}:\n${body.message}`);
    }

    await adapter.commentTask(
      taskId,
      JSON.stringify(
        buildCorrection({
          actionItem: body.actionItem,
          kind: 'silent_regret_feedback',
          note,
          recordedBy: 'User',
          recordedVia: 'keryx-web',
          now,
        }),
      ),
    );
  }

  return ok(json({ ok: true, task_id: taskId, kind, action: 'recorded' }));
}
