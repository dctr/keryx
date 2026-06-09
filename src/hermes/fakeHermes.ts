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
      return ok(tasks);
    }

    if (matches(request.args, ['kanban', '--board']) && request.args.includes('show')) {
      const taskId = request.args[4];
      const task = tasks.find((candidate) => candidate.id === taskId);
      return task ? ok({ task }) : fail(`No fake task found for ${taskId}`);
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
