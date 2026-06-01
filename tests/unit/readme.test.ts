import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const repoRoot = process.cwd();
const readmePath = join(repoRoot, 'README.md');

describe('user-facing README', () => {
  it('exists at the repository root', () => {
    expect(existsSync(readmePath), 'README.md should exist').toBe(true);
  });

  it('contains the essential install, setup, and run commands', () => {
    const readme = readReadme();

    for (const command of ['git clone', 'npm install', './keryx-setup.sh', 'npm start', './bin/opsctl doctor']) {
      expect(readme, `README should document ${command}`).toContain(command);
    }
  });

  it('explains setup, delivery target selection, and local-only mode', () => {
    const readme = readReadme();

    for (const phrase of [
      '$HERMES_HOME/skills/keryx/',
      'hermes send --list --json',
      '--delivery-target <target>',
      '--local-only',
      'defaultDeliveryTarget',
      'localOnly',
    ]) {
      expect(readme, `README should mention ${phrase}`).toContain(phrase);
    }
  });

  it('covers collector authoring and the action-card safety contract', () => {
    const readme = readReadme();

    for (const phrase of [
      'collectors/',
      'keryx.action_item.v1',
      'initial-status blocked',
      'idempotency key',
      'cursor safety',
      'untrusted source content',
      'keryx-worker',
    ]) {
      expect(readme, `README should mention ${phrase}`).toContain(phrase);
    }
  });

  it('warns against unsafe exposure and points to troubleshooting commands', () => {
    const readme = readReadme();

    for (const phrase of [
      '127.0.0.1',
      'Do not expose Keryx without external authentication',
      'deploy/caddy/Caddyfile.example',
      'basicauth',
      './bin/opsctl cron-status',
      './bin/opsctl validate-card',
      './bin/opsctl list --status blocked',
    ]) {
      expect(readme, `README should mention ${phrase}`).toContain(phrase);
    }
  });
});

function readReadme(): string {
  return readFileSync(readmePath, 'utf8');
}
