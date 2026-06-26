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

function writeConfig(body: Record<string, unknown>): string {
  const directory = mkdtempSync(join(tmpdir(), 'keryx-config-'));
  const configPath = join(directory, 'keryx.config.json');
  writeFileSync(configPath, JSON.stringify(body), 'utf8');
  return configPath;
}

describe('Keryx delivery and interrupt config (v005 Task 6.2)', () => {
  it('omits notify_target, interrupt budget, quiet hours, and band thresholds by default (digest-only)', () => {
    const config = loadConfig({ env: {}, configPath: null });

    expect(config.notifyTarget).toBeUndefined();
    expect(config.interruptBudget).toBeUndefined();
    expect(config.quietHours).toBeUndefined();
    expect(config.bandThresholds).toBeUndefined();
  });

  it('loads notify_target, interrupt budget, quiet hours, and band-threshold overrides from the file', () => {
    const configPath = writeConfig({
      board: 'keryx',
      defaultAssignee: 'default',
      hermesBin: 'hermes',
      notifyTarget: 'telegram',
      interruptBudget: { perTierPerDay: { urgent: 12, soon: 6 } },
      quietHours: { start: '22:00', end: '07:00' },
      bandThresholds: { warmingApprovals: 4, trustedApprovals: 12, maxOverrideRate: 0.1 },
    });

    const config = loadConfig({ env: {}, configPath });

    expect(config.notifyTarget).toBe('telegram');
    expect(config.interruptBudget).toEqual({ perTierPerDay: { urgent: 12, soon: 6 } });
    expect(config.quietHours).toEqual({ start: '22:00', end: '07:00' });
    expect(config.bandThresholds).toEqual({
      warmingApprovals: 4,
      trustedApprovals: 12,
      maxOverrideRate: 0.1,
    });
  });

  it('accepts a partial band-threshold override', () => {
    const configPath = writeConfig({ bandThresholds: { trustedApprovals: 20 } });

    const config = loadConfig({ env: {}, configPath });

    expect(config.bandThresholds).toEqual({ trustedApprovals: 20 });
  });

  it('rejects an empty notify_target', () => {
    const configPath = writeConfig({ notifyTarget: '   ' });

    expect(() => loadConfig({ env: {}, configPath })).toThrow(/notifyTarget/);
  });

  it('rejects quiet hours that are not HH:MM times', () => {
    const configPath = writeConfig({ quietHours: { start: '22:00', end: '7am' } });

    expect(() => loadConfig({ env: {}, configPath })).toThrow(/quietHours/);
  });

  it('rejects quiet hours missing an endpoint', () => {
    const configPath = writeConfig({ quietHours: { start: '22:00' } });

    expect(() => loadConfig({ env: {}, configPath })).toThrow(/quietHours/);
  });

  it('rejects a non-numeric interrupt budget entry', () => {
    const configPath = writeConfig({ interruptBudget: { perTierPerDay: { urgent: 'lots' } } });

    expect(() => loadConfig({ env: {}, configPath })).toThrow(/interruptBudget/);
  });

  it('rejects a negative interrupt budget entry', () => {
    const configPath = writeConfig({ interruptBudget: { perTierPerDay: { urgent: -1 } } });

    expect(() => loadConfig({ env: {}, configPath })).toThrow(/interruptBudget/);
  });

  it('rejects a band threshold override that is not a number', () => {
    const configPath = writeConfig({ bandThresholds: { trustedApprovals: 'high' } });

    expect(() => loadConfig({ env: {}, configPath })).toThrow(/bandThresholds/);
  });
});
