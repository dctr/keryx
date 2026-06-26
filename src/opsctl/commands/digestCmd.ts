// digestCmd: render or deliver the relevancy-grouped digest of silent outcomes.

import { composeDigest, extractOutcomes, type DigestCadence } from '../digest';
import type { CommandResult } from '../output';
import { fail, ok } from '../output';
import { type CommandContext, stringFlag } from '../shared';

function parseCadence(value: string | undefined): { ok: true; value: DigestCadence } | { ok: false; error: CommandResult } {
  if (value === undefined) {
    return { ok: true, value: 'daily' };
  }
  if (value === 'daily' || value === 'weekly') {
    return { ok: true, value };
  }
  return { ok: false, error: fail('FAIL digest --cadence must be daily or weekly', 2) };
}

// Reads silent outcomes from the review log (done cards), composes the relevancy-grouped
// digest, and either renders it (--preview) or delivers it via `hermes send` to the
// configured notify_target (PRD §7.6). Brief discipline: when there is nothing to report
// the digest is `[SILENT]` and nothing is sent. A non-preview send with no notify_target
// configured fails clearly rather than silently dropping the digest.
export async function digestCmd(ctx: CommandContext): Promise<CommandResult> {
  const { parsed, adapter, options } = ctx;
  const cadence = parseCadence(stringFlag(parsed, 'cadence'));
  if (!cadence.ok) {
    return cadence.error;
  }

  const tasks = await adapter.listTasksWithComments({ status: 'done' });
  const outcomes = extractOutcomes(tasks);
  const result = composeDigest(outcomes, { cadence: cadence.value });

  if (parsed.flags.get('preview') === true) {
    return ok(result.message);
  }

  // Nothing to report: send nothing (daily-brief/weekly-brief discipline).
  if (result.silent) {
    return ok(result.message);
  }

  const notifyTarget = options.config?.notifyTarget;
  if (!notifyTarget) {
    return fail(
      'FAIL digest send requires a configured notify_target; set it in keryx.config.json or rerun with --preview to render without sending',
    );
  }

  await adapter.sendMessage(notifyTarget, result.message);
  return ok(result.message);
}
