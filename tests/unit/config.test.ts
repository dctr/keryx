import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { DEFAULT_KERYX_CONFIG, loadConfig } from '../../src/config';

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
    expect(config.defaultDeliveryTarget).toBeNull();
    expect(config.localOnly).toBe(true);
    expect(config.host).toBe('127.0.0.1');
    expect(config.port).toBe(4173);
  });

  it('merges an explicit config-file override over the defaults', () => {
    const directory = mkdtempSync(join(tmpdir(), 'keryx-config-'));
    const configPath = join(directory, 'keryx.config.json');
    writeFileSync(
      configPath,
      JSON.stringify({
        board: 'keryx-test',
        pollIntervalMs: 5000,
        defaultDeliveryTarget: 'telegram',
        localOnly: false,
        hermesBin: '/tmp/fake-hermes',
        host: '0.0.0.0',
        port: 8080,
      }),
      'utf8',
    );

    const config = loadConfig({ env: {}, configPath });

    expect(config).toMatchObject({
      board: 'keryx-test',
      pollIntervalMs: 5000,
      defaultAssignee: 'default',
      defaultDeliveryTarget: 'telegram',
      localOnly: false,
      hermesBin: '/tmp/fake-hermes',
      host: '0.0.0.0',
      port: 8080,
      configPath,
    });
  });

  it('carries HERMES_HOME from the supplied environment instead of reading real profile state', () => {
    const hermesHome = mkdtempSync(join(tmpdir(), 'keryx-hermes-home-'));

    const config = loadConfig({ env: { HERMES_HOME: hermesHome }, configPath: null });

    expect(config.hermesHome).toBe(hermesHome);
  });
});
