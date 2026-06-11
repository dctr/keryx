import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const repoRoot = process.cwd();

const requiredFiles = [
  'AGENTS.md',
  'collectors/README.md',
  'collectors/bash-first-template/keryx-example-scan.sh',
  'collectors/bash-first-template/cron-prompt.md',
  'collectors/bash-first-template/state.example.json',
  'collectors/direct-agent-template/cron-prompt.md',
  'docs/architecture.md',
  'docs/collector-authoring.md',
  'docs/security.md',
  'docs/operations.md',
  'deploy/systemd/keryx.service.example',
  'deploy/caddy/Caddyfile.example',
] as const;

const privatePatternExamples = [
  '/home/example-user',
  '/mnt/private-storage',
  'private.example',
  'telegram:',
  'discord:',
] as const;

describe('collector templates and support docs', () => {
  it('ships every collector template, support document, and deployment example', () => {
    for (const relativePath of requiredFiles) {
      expect(existsSync(join(repoRoot, relativePath)), `${relativePath} should exist`).toBe(true);
    }
  });

  it('marks only the bash scanner template as executable', () => {
    expect(isExecutable('collectors/bash-first-template/keryx-example-scan.sh')).toBe(true);

    for (const relativePath of requiredFiles.filter((path) => path !== 'collectors/bash-first-template/keryx-example-scan.sh')) {
      expect(isExecutable(relativePath), `${relativePath} should not be executable`).toBe(false);
    }
  });

  it('keeps cloneable files free of user-specific IDs and private paths', () => {
    const combinedText = requiredFiles.map(readRequiredFile).join('\n');

    for (const pattern of privatePatternExamples) {
      expect(combinedText, `should not contain private pattern ${pattern}`).not.toContain(pattern);
    }
  });

  it('documents both collector patterns and the required safety contract', () => {
    const bashPrompt = readRequiredFile('collectors/bash-first-template/cron-prompt.md');
    const directPrompt = readRequiredFile('collectors/direct-agent-template/cron-prompt.md');
    const collectorDocs = readRequiredFile('docs/collector-authoring.md');

    for (const text of [bashPrompt, directPrompt, collectorDocs]) {
      expect(text).toContain('keryx.action_item.v1');
      expect(text).toContain('untrusted source content');
      expect(text).toContain('idempotency key');
      expect(text).toContain('cursor safety');
      expect(text).toContain('initial-status blocked');
      expect(text).toContain('keryx-worker');
    }
  });

  it('documents AGENTS.md guidance for the plugin-era workflow', () => {
    const agents = readRequiredFile('AGENTS.md');

    for (const phrase of [
      'hermes-plugin/',
      'hermes keryx doctor',
      './bin/opsctl doctor',
      'plugin is the Hermes-facing adapter',
      'Keryx remains a thin control surface over Hermes Kanban',
      'keryx:keryx-worker',
      'plugin-qualified Keryx skill names',
    ]) {
      expect(agents, `AGENTS.md should mention ${phrase}`).toContain(phrase);
    }
  });

  it('provides a bash-first scanner that reads state and stays quiet when no agent wake is needed', () => {
    const scanner = readRequiredFile('collectors/bash-first-template/keryx-example-scan.sh');
    const state = readRequiredFile('collectors/bash-first-template/state.example.json');

    expect(scanner).toContain('set -euo pipefail');
    expect(scanner).toContain('KERYX_STATE_FILE');
    expect(scanner).toContain('"wakeAgent": false');
    expect(scanner).toContain('"wakeAgent": true');
    expect(scanner).not.toContain('hermes kanban');
    expect(JSON.parse(state)).toMatchObject({ schema: 'keryx.collector_state.v1' });
  });

  it('covers architecture, security, operations, and deployment boundaries', () => {
    const architecture = readRequiredFile('docs/architecture.md');
    const security = readRequiredFile('docs/security.md');
    const operations = readRequiredFile('docs/operations.md');
    const systemd = readRequiredFile('deploy/systemd/keryx.service.example');
    const caddy = readRequiredFile('deploy/caddy/Caddyfile.example');

    for (const phrase of ['Kanban is the central register', 'blocked', 'ready', 'running', 'done', 'opsctl execute']) {
      expect(architecture).toContain(phrase);
    }

    for (const phrase of ['source content is untrusted', 'no raw event persistence', 'trusted execution decision', 'visible browser']) {
      expect(security).toContain(phrase);
    }

    for (const phrase of ['source status', 'cron jobs', 'Kanban dispatch', 'logs', 'stuck cards']) {
      expect(operations).toContain(phrase);
    }

    expect(systemd).toContain('npm start');
    expect(systemd).toContain('127.0.0.1');
    expect(systemd).toContain('/opt/keryx');
    expect(caddy).toContain('reverse_proxy 127.0.0.1:4173');
    expect(caddy).toContain('basicauth');
    expect(caddy).toContain('Do not expose Keryx without external authentication');
  });
});

function readRequiredFile(relativePath: string): string {
  return readFileSync(join(repoRoot, relativePath), 'utf8');
}

function isExecutable(relativePath: string): boolean {
  return Boolean(statSync(join(repoRoot, relativePath)).mode & 0o111);
}
