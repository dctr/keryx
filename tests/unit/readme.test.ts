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

    for (const command of [
      'git clone',
      'npm install',
      './keryx-setup.sh',
      'npm start',
      'hermes keryx doctor',
      './bin/opsctl doctor',
    ]) {
      expect(readme, `README should document ${command}`).toContain(command);
    }
  });

  it('explains plugin setup and read-only delivery-target diagnostics without dead config fields', () => {
    const readme = readReadme();

    for (const phrase of [
      'Hermes plugin named `keryx`',
      '$HERMES_HOME/plugins/keryx',
      'hermes plugins enable keryx',
      'hermes keryx doctor',
      'hermes keryx delivery-targets',
      'hermes send --list --json',
    ]) {
      expect(readme, `README should mention ${phrase}`).toContain(phrase);
    }

    for (const removed of [
      '--delivery-target',
      '--local-only',
      'defaultDeliveryTarget',
      'localOnly',
      'pollIntervalMs',
    ]) {
      expect(readme, `README should no longer mention removed config surface ${removed}`).not.toContain(removed);
    }
  });

  it('documents env-based HOST/PORT server defaults instead of config host/port fields', () => {
    const readme = readReadme();

    expect(readme).toContain('127.0.0.1');
    expect(readme).toContain('4173');
    expect(readme).toMatch(/HOST.*PORT|PORT.*HOST/s);
    expect(readme, 'README config example should not reuse the removed host field').not.toMatch(/"host"\s*:/);
    expect(readme, 'README config example should not reuse the removed port field').not.toMatch(/"port"\s*:/);
  });

  it('covers collector authoring and the plugin-backed action-card safety contract', () => {
    const readme = readReadme();

    for (const phrase of [
      'collectors/',
      'keryx.action_item.v1',
      'initial-status blocked',
      'idempotency key',
      'cursor safety',
      'untrusted source content',
      'keryx:keryx-worker',
      'hermes keryx template-card --source <source> --collector <collector>',
      'hermes keryx schema action-item',
      'hermes keryx validate-card <card.json>',
      'hermes keryx create-card <card.json>',
    ]) {
      expect(readme, `README should mention ${phrase}`).toContain(phrase);
    }
  });

  it('warns against unsafe exposure and points to plugin-era troubleshooting commands', () => {
    const readme = readReadme();

    for (const phrase of [
      '127.0.0.1',
      'Do not expose Keryx without external authentication',
      'deploy/caddy/Caddyfile.example',
      'basicauth',
      'hermes keryx cron-status',
      'hermes keryx validate-card',
      'hermes keryx list --status blocked',
      'FAIL plugin',
    ]) {
      expect(readme, `README should mention ${phrase}`).toContain(phrase);
    }
  });

  it('keeps the generic collector skill qualified while referencing created collector skills unqualified', () => {
    const readme = readReadme();

    // The repo-shipped generic collector skill stays plugin-qualified.
    expect(readme).toContain('keryx:keryx-collector');
    // Created source-specific collector skills live in Hermes' space and are unqualified.
    expect(readme).toContain('keryx-collector-<source>');
    expect(readme, 'README should not qualify created collector skills with keryx:').not.toContain(
      'keryx:keryx-collector-<source>',
    );
  });

  it('does not document copied skills as the setup source of truth', () => {
    const readme = readReadme();

    for (const stalePhrase of [
      'installs bundled skills into `$HERMES_HOME/skills/keryx/`',
      '$HERMES_HOME/skills/keryx/',
      'FAIL skills',
      'attach the `keryx-worker` skill',
    ]) {
      expect(readme, `README should not mention stale setup phrase ${stalePhrase}`).not.toContain(stalePhrase);
    }
  });
});

function readReadme(): string {
  return readFileSync(readmePath, 'utf8');
}
