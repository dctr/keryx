// metricsCmd: attention-economics metrics derived from the Kanban audit trail.

import { HermesCliAdapter } from '../../hermes/adapter';
import { computeMetrics, formatMetrics, type MetricsWindow } from '../../policy/metrics';
import type { CommandResult } from '../output';
import { fail, json, ok } from '../output';
import { type ParsedArgs, stringFlag } from '../shared';

// Parses a relative duration suffix (s/m/h/d/w) into a metrics window anchored at `now`.
// An empty range means all-time (unbounded). Rejects anything that is not <integer><unit>.
function parseMetricsWindow(
  value: string | undefined,
  now: () => Date,
): { ok: true; value: MetricsWindow } | { ok: false; error: CommandResult } {
  if (value === undefined) {
    return { ok: true, value: {} };
  }

  const match = value.trim().match(/^(\d+)\s*(s|m|h|d|w)$/i);
  if (!match) {
    return {
      ok: false,
      error: fail('FAIL metrics --window must be a relative range like 24h, 7d, or 2w', 2),
    };
  }

  const amount = Number.parseInt(match[1], 10);
  const unitMs: Record<string, number> = {
    s: 1000,
    m: 60 * 1000,
    h: 60 * 60 * 1000,
    d: 24 * 60 * 60 * 1000,
    w: 7 * 24 * 60 * 60 * 1000,
  };
  const span = amount * unitMs[match[2].toLowerCase()];
  return { ok: true, value: { from: new Date(now().getTime() - span) } };
}

// Attention-economics metrics (PRD §7.9, §11; D7) read from the live Kanban audit trail.
// No second store: every figure derives from task status + the validated machine comments
// Keryx already writes. `--window <range>` (e.g. 7d, 24h, 2w) scopes to comments newer than
// now - range; `--json` emits the full KeryxMetrics object for the UI/automation.
export async function metricsCmd(parsed: ParsedArgs, adapter: HermesCliAdapter, now: () => Date): Promise<CommandResult> {
  const windowResult = parseMetricsWindow(stringFlag(parsed, 'window'), now);
  if (!windowResult.ok) {
    return windowResult.error;
  }

  const tasks = await adapter.listTasksWithComments();
  const computed = computeMetrics(tasks, windowResult.value);

  if (parsed.flags.get('json') === true) {
    return ok(json(computed));
  }
  return ok(formatMetrics(computed));
}
