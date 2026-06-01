import { constants } from 'node:fs';
import { access, readFile, stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';

import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';

import { type KeryxConfig, loadConfig } from '../config';
import { HermesCliAdapter } from '../hermes/adapter';
import type { HermesRunner } from '../hermes/types';
import { runOpsctl as defaultRunOpsctl, type RunOpsctlOptions } from '../opsctl/commands';
import { registerApiRoutes, type OpsctlRunner, type ServerHermesAdapter } from './routes';

export interface CreateServerOptions {
  adapter?: ServerHermesAdapter;
  config?: KeryxConfig;
  configPath?: string | null;
  cwd?: string;
  env?: Record<string, string | undefined>;
  hermesRunner?: HermesRunner;
  now?: () => Date;
  runOpsctl?: OpsctlRunner;
  webRoot?: string | null;
}

export function createAppName(): string {
  return 'Keryx';
}

export function createServer(options: CreateServerOptions = {}): FastifyInstance {
  const config = options.config ?? loadConfig({ env: options.env, cwd: options.cwd, configPath: options.configPath });
  const adapter = options.adapter ?? new HermesCliAdapter(config, options.hermesRunner);
  const server = Fastify({ logger: false });
  const opsctlOptions: RunOpsctlOptions = {
    config,
    configPath: options.configPath,
    cwd: options.cwd,
    env: options.env,
    hermesRunner: options.hermesRunner,
  };

  registerApiRoutes(server, {
    adapter,
    config,
    hermesRunner: options.hermesRunner,
    now: options.now,
    opsctlOptions,
    runOpsctl: options.runOpsctl ?? defaultRunOpsctl,
  });
  registerStaticWebRoutes(server, options.webRoot === null ? null : (options.webRoot ?? resolve(options.cwd ?? process.cwd(), 'dist/web')));

  return server;
}

function registerStaticWebRoutes(server: FastifyInstance, webRoot: string | null): void {
  if (webRoot === null) {
    return;
  }

  const root = resolve(webRoot);
  server.get('/', async (_request, reply) => sendStaticFile(reply, root, 'index.html'));
  server.get('/assets/*', async (request, reply) => {
    const wildcard = (request.params as { '*': string })['*'];
    return sendStaticFile(reply, root, `assets/${wildcard}`);
  });
}

async function sendStaticFile(reply: FastifyReply, root: string, relativePath: string): Promise<FastifyReply> {
  const filePath = resolve(root, relativePath);
  if (!isPathInsideRoot(root, filePath)) {
    return reply.code(404).send({ ok: false, error: 'not found' });
  }

  try {
    await access(filePath, constants.R_OK);
    const details = await stat(filePath);
    if (!details.isFile()) {
      return reply.code(404).send({ ok: false, error: 'not found' });
    }
    return reply.type(contentTypeFor(filePath)).send(await readFile(filePath));
  } catch {
    return reply.code(404).send({ ok: false, error: 'not found' });
  }
}

function isPathInsideRoot(root: string, filePath: string): boolean {
  const resolvedRoot = resolve(root);
  return filePath === resolvedRoot || filePath.startsWith(`${resolvedRoot}${sep}`);
}

function contentTypeFor(filePath: string): string {
  switch (extname(filePath)) {
    case '.html':
      return 'text/html; charset=utf-8';
    case '.js':
      return 'text/javascript; charset=utf-8';
    case '.css':
      return 'text/css; charset=utf-8';
    case '.svg':
      return 'image/svg+xml';
    case '.json':
      return 'application/json; charset=utf-8';
    case '.ico':
      return 'image/x-icon';
    default:
      return 'application/octet-stream';
  }
}
