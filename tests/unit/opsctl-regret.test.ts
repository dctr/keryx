import { describe, expect, it, vi } from 'vitest';

import { loadConfig } from '../../src/config';
import { runOpsctl } from '../../src/opsctl/commands';
import { sampleActionItem } from '../helpers/sampleActionItem';
import type { HermesRunner, KanbanTask } from '../../src/hermes/types';

const actionItem = sampleActionItem();
const recordedAt = new Date('2026-06-26T09:00:00.000Z');

function task(overrides: Partial<KanbanTask>): KanbanTask {
  return { id: 't_default', title: 'Keryx action', status: 'done', body: JSON.stringify(actionItem), ...overrides };
}

function createRunner(returnedTask: KanbanTask) {
  return vi.fn<HermesRunner>(async (request) => {
    const command = request.args[3];
    if (command === 'show') {
      return { stdout: JSON.stringify({ task: returnedTask }), stderr: '', exitCode: 0 };
    }
    if (command === 'comment') {
      return { stdout: 'Comment added.\n', stderr: '', exitCode: 0 };
    }
    return { stdout: '', stderr: `unexpected command: ${request.args.join(' ')}`, exitCode: 1 };
  });
}

describe('opsctl regret', () => {
  it('appends a keryx.regret.v1 comment for a should_have_asked signal', async () => {
    const runner = createRunner(task({ id: 't_silent' }));

    const result = await runOpsctl(['regret', 't_silent', '--kind', 'should_have_asked', '--note', 'Too aggressive.'], {
      config: loadConfig({ env: {}, configPath: null }),
      hermesRunner: runner,
      now: () => recordedAt,
    });

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, task_id: 't_silent', kind: 'should_have_asked' });
    expect(runner.mock.calls.map((call) => call[0].args[3])).toEqual(['comment']);
    const commentArgs = runner.mock.calls[0][0].args;
    expect(JSON.parse(commentArgs[5])).toEqual({
      schema: 'keryx.regret.v1',
      kind: 'should_have_asked',
      note: 'Too aggressive.',
      recorded_by: 'User',
      recorded_at: '2026-06-26T09:00:00.000Z',
    });
  });

  it('defaults the note to null when omitted', async () => {
    const runner = createRunner(task({ id: 't_silent' }));
    const result = await runOpsctl(['regret', 't_silent', '--kind', 'should_have_acted'], {
      config: loadConfig({ env: {}, configPath: null }),
      hermesRunner: runner,
      now: () => recordedAt,
    });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(runner.mock.calls[0][0].args[5])).toMatchObject({ kind: 'should_have_acted', note: null });
  });

  it('rejects an unknown kind with exit code 2 before mutating', async () => {
    const runner = createRunner(task({ id: 't_silent' }));
    const result = await runOpsctl(['regret', 't_silent', '--kind', 'nonsense'], {
      config: loadConfig({ env: {}, configPath: null }),
      hermesRunner: runner,
    });
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('FAIL regret --kind must be should_have_acted or should_have_asked');
    expect(runner).not.toHaveBeenCalled();
  });

  it('requires a task id', async () => {
    const result = await runOpsctl(['regret', '--kind', 'should_have_acted'], { env: {}, configPath: null });
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('FAIL regret requires a task id');
  });

  it('rejects a task id beginning with a dash before querying Hermes', async () => {
    const runner = createRunner(task({ id: 't_silent' }));
    const result = await runOpsctl(['regret', '-rf', '--kind', 'should_have_acted'], {
      config: loadConfig({ env: {}, configPath: null }),
      hermesRunner: runner,
    });
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('FAIL task id must not begin with "-"');
    expect(runner).not.toHaveBeenCalled();
  });
});
