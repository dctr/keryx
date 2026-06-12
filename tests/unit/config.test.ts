import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { DEFAULT_KERYX_CONFIG, loadConfig } from '../../src/config';

const REMOVED_FIELDS = ['pollIntervalMs', 'defaultDeliveryTarget', 'localOnly', 'host', 'port'] as const;

describe('Keryx config loading', () => {
  it('returns safe local defaults when no config file is present', () => {
    const config = loadConfig({ env: {}, configPath: null });

    expect(config).toEqual({
      ...DEFAULT_KERYX_CONFIG,
      hermesHome: undefined,
      configPath: undefined,
    });
    expect(config.board).toBe('keryx');
    expect(config.defaultAssignee).toBe('default');
    expect(config.hermesBin).toBe('hermes');
  });

  it('does not validate or surface the removed transport/delivery fields', () => {
    const config = loadConfig({ env: {}, configPath: null }) as unknown as Record<string, unknown>;

    for (const field of REMOVED_FIELDS) {
      expect(field in config, `config should not expose removed field ${field}`).toBe(false);
      expect(field in DEFAULT_KERYX_CONFIG, `defaults should not include removed field ${field}`).toBe(false);
    }
  });

  it('ignores unknown legacy fields present in an existing config file', () => {
    const directory = mkdtempSync(join(tmpdir(), 'keryx-config-'));
    const configPath = join(directory, 'keryx.config.json');
    writeFileSync(
      configPath,
      JSON.stringify({
        board: 'keryx-test',
        defaultAssignee: 'reviewer',
        hermesBin: '/tmp/fake-hermes',
        pollIntervalMs: 5000,
        defaultDeliveryTarget: 'telegram',
        localOnly: false,
        host: '0.0.0.0',
        port: 8080,
      }),
      'utf8',
    );

    const config = loadConfig({ env: {}, configPath }) as unknown as Record<string, unknown>;

    expect(config).toMatchObject({
      board: 'keryx-test',
      defaultAssignee: 'reviewer',
      hermesBin: '/tmp/fake-hermes',
      configPath,
    });
    for (const field of REMOVED_FIELDS) {
      expect(field in config, `loaded config should drop legacy field ${field}`).toBe(false);
    }
  });

  it('carries HERMES_HOME from the supplied environment instead of reading real profile state', () => {
    const hermesHome = mkdtempSync(join(tmpdir(), 'keryx-hermes-home-'));

    const config = loadConfig({ env: { HERMES_HOME: hermesHome }, configPath: null });

    expect(config.hermesHome).toBe(hermesHome);
  });
});
