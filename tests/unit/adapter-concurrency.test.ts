import { describe, expect, it } from 'vitest';
import { HermesCliAdapter } from '../../src/hermes/adapter';
import type { HermesRunner, HermesRunRequest, HermesRunResult } from '../../src/hermes/types';
import type { KeryxConfig } from '../../src/config';

// Minimal config needed by HermesCliAdapter
const baseConfig: KeryxConfig = {
  board: 'test-board',
  hermesBin: 'hermes',
  defaultAssignee: 'default',
};

function makeTaskJson(id: string, title: string): string {
  return JSON.stringify({
    id,
    title,
    body: '',
    status: 'ready',
    assignee: 'default',
    created_at: 0,
    started_at: null,
    completed_at: null,
    result: null,
    priority: 0,
    workspace_kind: 'scratch',
    workspace_path: null,
    created_by: 'user',
    current_run_id: null,
    model_override: null,
    tenant: null,
    comments: [],
  });
}

function makeShowJson(id: string, title: string): string {
  const task = JSON.parse(makeTaskJson(id, title));
  return JSON.stringify({ task });
}

function makeListJson(count: number): string {
  const tasks = Array.from({ length: count }, (_, i) => JSON.parse(makeTaskJson(`t_${i}`, `Task ${i}`)));
  return JSON.stringify(tasks);
}

describe('listTasksWithComments concurrency', () => {
  it('keeps peak in-flight <= 8 and preserves input order on a 25-task board', async () => {
    const taskCount = 25;
    let inFlight = 0;
    let peakInFlight = 0;

    const fakeRunner: HermesRunner = async (req: HermesRunRequest): Promise<HermesRunResult> => {
      const args = req.args;
      // list call
      if (args.includes('list')) {
        return { stdout: makeListJson(taskCount), stderr: '', exitCode: 0 };
      }
      // show call — track concurrency
      const idArg = args[args.indexOf('show') + 1] ?? 'unknown';
      inFlight++;
      peakInFlight = Math.max(peakInFlight, inFlight);
      // simulate async work
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight--;
      return { stdout: makeShowJson(idArg, `Task ${idArg.replace('t_', '')}`), stderr: '', exitCode: 0 };
    };

    const adapter = new HermesCliAdapter(baseConfig, fakeRunner);
    const tasks = await adapter.listTasksWithComments();

    expect(peakInFlight).toBeLessThanOrEqual(8);
    expect(tasks).toHaveLength(taskCount);
    // Order must match input (t_0 .. t_24)
    tasks.forEach((task, i) => {
      expect(task.id).toBe(`t_${i}`);
    });
  });
});
