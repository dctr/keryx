import type { DeliveryTarget, HermesRunRequest, HermesRunner, KanbanTask } from './types';

export interface FakeHermesOptions {
  tasks?: KanbanTask[];
  deliveryTargets?: DeliveryTarget[];
}

export interface FakeHermes {
  runner: HermesRunner;
  requests: HermesRunRequest[];
}

export function createFakeHermes(options: FakeHermesOptions = {}): FakeHermes {
  const requests: HermesRunRequest[] = [];
  const tasks = options.tasks ?? [];
  const deliveryTargets = options.deliveryTargets ?? [];

  const runner: HermesRunner = async (request) => {
    requests.push(request);

    if (matches(request.args, ['kanban', '--board']) && request.args.includes('list')) {
      // Model the live CLI contract: `kanban list --json` does NOT embed per-task
      // comments. Callers that need comments must enrich via `show` (listTasksWithComments).
      return ok(tasks.map((task) => stripComments(task)));
    }

    if (matches(request.args, ['kanban', '--board']) && request.args.includes('show')) {
      const taskId = request.args[4];
      const task = tasks.find((candidate) => candidate.id === taskId);
      if (!task) {
        return fail(`No fake task found for ${taskId}`);
      }
      // Model the live CLI envelope: `show --json` returns `comments` as a TOP-LEVEL
      // sibling of `task`, NOT nested inside it. This is the only source of per-task comments.
      const { comments = [], ...taskWithoutComments } = task;
      return ok({ task: taskWithoutComments, comments });
    }

    if (matches(request.args, ['send', '--list'])) {
      return ok(toHermes16DeliveryTargets(deliveryTargets));
    }

    if (matches(request.args, ['cron', 'list'])) {
      return ok({ jobs: [] });
    }

    if (matches(request.args, ['kanban', '--board']) && request.args[3] === 'comment') {
      return { stdout: 'Comment added.\n', stderr: '', exitCode: 0 };
    }

    if (matches(request.args, ['kanban', '--board']) && request.args[3] === 'create') {
      return ok({ id: 't_created', status: 'blocked' });
    }

    if (matches(request.args, ['kanban', '--board']) && ['block', 'assign'].includes(request.args[3])) {
      return { stdout: '', stderr: '', exitCode: 0 };
    }

    if (matches(request.args, ['kanban', '--board']) && request.args[3] === 'archive') {
      return { stdout: 'Archived 1 task.\n', stderr: '', exitCode: 0 };
    }

    if (matches(request.args, ['kanban', '--board']) && ['promote', 'dispatch'].includes(request.args[3])) {
      return ok({ ok: true });
    }

    return fail(`Unhandled fake Hermes command: ${request.args.join(' ')}`);
  };

  return { runner, requests };
}

function matches(args: string[], prefix: string[]): boolean {
  return prefix.every((part, index) => args[index] === part);
}

// Returns a shallow copy of the task with `comments` removed, mirroring how the live
// `kanban list --json` output omits per-task comments (only `show --json` embeds them).
function stripComments(task: KanbanTask): KanbanTask {
  const { comments: _comments, ...rest } = task;
  return rest;
}

function toHermes16DeliveryTargets(deliveryTargets: DeliveryTarget[]): unknown {
  const platforms: Record<string, Array<Record<string, unknown>>> = {};

  for (const target of deliveryTargets) {
    const [platformFromTarget, ...idParts] = target.target.split(':');
    const platform = target.platform ?? platformFromTarget;
    const id = idParts.join(':');
    platforms[platform] ??= [];
    if (!id && target.target === platform) {
      continue;
    }
    platforms[platform].push({
      id: id || target.target,
      name: target.label ?? target.target,
      type: 'test',
    });
  }

  return { platforms };
}

function ok(value: unknown) {
  return { stdout: JSON.stringify(value), stderr: '', exitCode: 0 };
}

function fail(message: string) {
  return { stdout: '', stderr: message, exitCode: 1 };
}
