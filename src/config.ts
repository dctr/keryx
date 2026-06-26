import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export interface KeryxConfigFields {
  board: string;
  defaultAssignee: string;
  hermesBin: string;
}

export interface InterruptBudget {
  perTierPerDay: Record<string, number>;
}

export interface QuietHours {
  start: string;
  end: string;
}

export interface BandThresholdOverrides {
  warmingApprovals?: number;
  trustedApprovals?: number;
  maxOverrideRate?: number;
}

/**
 * Optional delivery/interrupt-shaping config (PRD §9, v005 Task 6.2). All fields
 * are optional with safe defaults: with no notifyTarget Keryx stays digest-only
 * and never pushes an interrupt. interruptBudget caps interrupt pushes per tier
 * per day; quietHours suppresses pushes within a window; bandThresholds overrides
 * the confidence-band constants (src/policy/confidence.ts).
 */
export interface KeryxDeliveryFields {
  notifyTarget?: string;
  interruptBudget?: InterruptBudget;
  quietHours?: QuietHours;
  bandThresholds?: BandThresholdOverrides;
}

export interface KeryxConfig extends KeryxConfigFields, KeryxDeliveryFields {
  hermesHome?: string;
  configPath?: string;
}

export type KeryxConfigOverrides = Partial<KeryxConfigFields> & Pick<Partial<KeryxConfig>, 'hermesHome'>;

export interface LoadConfigOptions {
  configPath?: string | null;
  cwd?: string;
  env?: Record<string, string | undefined>;
  overrides?: KeryxConfigOverrides;
}

export const DEFAULT_KERYX_CONFIG: KeryxConfigFields = Object.freeze({
  board: 'keryx',
  defaultAssignee: 'default',
  hermesBin: 'hermes',
});

const KNOWN_CONFIG_KEYS = new Set<keyof KeryxConfigFields>(['board', 'defaultAssignee', 'hermesBin']);

const DELIVERY_CONFIG_KEYS = new Set<keyof KeryxDeliveryFields>([
  'notifyTarget',
  'interruptBudget',
  'quietHours',
  'bandThresholds',
]);

const BAND_THRESHOLD_KEYS = new Set<keyof BandThresholdOverrides>([
  'warmingApprovals',
  'trustedApprovals',
  'maxOverrideRate',
]);

const HH_MM = /^([01]\d|2[0-3]):[0-5]\d$/;

const CONFIG_FILE_NAME = 'keryx.config.json';

export function loadConfig(options: LoadConfigOptions = {}): KeryxConfig {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const configPath = resolveConfigPath({ configPath: options.configPath, env, cwd });
  const fileConfig = configPath ? readConfigFile(configPath) : {};
  const merged = validateConfig({ ...DEFAULT_KERYX_CONFIG, ...fileConfig, ...options.overrides });
  const delivery = validateDelivery(fileConfig);
  const hermesHome = options.overrides?.hermesHome ?? env.HERMES_HOME;

  return {
    ...merged,
    ...delivery,
    hermesHome,
    configPath,
  };
}

function resolveConfigPath(options: {
  configPath?: string | null;
  env: Record<string, string | undefined>;
  cwd: string;
}): string | undefined {
  if (options.configPath === null) {
    return undefined;
  }

  if (options.configPath) {
    return resolve(options.cwd, options.configPath);
  }

  if (options.env.KERYX_CONFIG) {
    return resolve(options.cwd, options.env.KERYX_CONFIG);
  }

  const defaultPath = resolve(options.cwd, CONFIG_FILE_NAME);
  return existsSync(defaultPath) ? defaultPath : undefined;
}

function readConfigFile(configPath: string): Partial<KeryxConfigFields> & KeryxDeliveryFields {
  const parsed = JSON.parse(readFileSync(configPath, 'utf8')) as unknown;

  if (!isPlainObject(parsed)) {
    throw new Error(`Keryx config must be a JSON object: ${configPath}`);
  }

  return { ...pickKnownKeys(parsed), ...pickDeliveryKeys(parsed) };
}

function pickKnownKeys(parsed: Record<string, unknown>): Partial<KeryxConfigFields> {
  const result: Partial<KeryxConfigFields> = {};
  for (const key of KNOWN_CONFIG_KEYS) {
    if (key in parsed) {
      result[key] = parsed[key] as KeryxConfigFields[typeof key];
    }
  }
  return result;
}

function pickDeliveryKeys(parsed: Record<string, unknown>): KeryxDeliveryFields {
  const result: KeryxDeliveryFields = {};
  for (const key of DELIVERY_CONFIG_KEYS) {
    if (key in parsed) {
      (result as Record<string, unknown>)[key] = parsed[key];
    }
  }
  return result;
}

function validateConfig(candidate: Partial<KeryxConfigFields>): KeryxConfigFields {
  const config = { ...DEFAULT_KERYX_CONFIG, ...candidate };

  assertNonEmptyString(config.board, 'board');
  assertNonEmptyString(config.defaultAssignee, 'defaultAssignee');
  assertNonEmptyString(config.hermesBin, 'hermesBin');

  return config;
}

function assertNonEmptyString(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`Keryx config field ${field} must be a non-empty string`);
  }
}

function validateDelivery(candidate: KeryxDeliveryFields): KeryxDeliveryFields {
  const result: KeryxDeliveryFields = {};

  if (candidate.notifyTarget !== undefined) {
    assertNonEmptyString(candidate.notifyTarget, 'notifyTarget');
    result.notifyTarget = candidate.notifyTarget;
  }

  if (candidate.interruptBudget !== undefined) {
    result.interruptBudget = validateInterruptBudget(candidate.interruptBudget);
  }

  if (candidate.quietHours !== undefined) {
    result.quietHours = validateQuietHours(candidate.quietHours);
  }

  if (candidate.bandThresholds !== undefined) {
    result.bandThresholds = validateBandThresholds(candidate.bandThresholds);
  }

  return result;
}

function validateInterruptBudget(value: unknown): InterruptBudget {
  if (!isPlainObject(value) || !isPlainObject(value.perTierPerDay)) {
    throw new Error('Keryx config field interruptBudget must be { perTierPerDay: { <tier>: number } }');
  }
  const perTierPerDay: Record<string, number> = {};
  for (const [tier, count] of Object.entries(value.perTierPerDay)) {
    if (typeof count !== 'number' || !Number.isFinite(count) || count < 0) {
      throw new Error(
        `Keryx config field interruptBudget.perTierPerDay.${tier} must be a non-negative number`,
      );
    }
    perTierPerDay[tier] = count;
  }
  return { perTierPerDay };
}

function validateQuietHours(value: unknown): QuietHours {
  if (!isPlainObject(value)) {
    throw new Error('Keryx config field quietHours must be { start: HH:MM, end: HH:MM }');
  }
  for (const field of ['start', 'end'] as const) {
    const at = value[field];
    if (typeof at !== 'string' || !HH_MM.test(at)) {
      throw new Error(`Keryx config field quietHours.${field} must be an HH:MM time`);
    }
  }
  return { start: value.start as string, end: value.end as string };
}

function validateBandThresholds(value: unknown): BandThresholdOverrides {
  if (!isPlainObject(value)) {
    throw new Error('Keryx config field bandThresholds must be an object of numeric overrides');
  }
  const result: BandThresholdOverrides = {};
  for (const key of BAND_THRESHOLD_KEYS) {
    if (!(key in value)) {
      continue;
    }
    const num = value[key];
    if (typeof num !== 'number' || !Number.isFinite(num) || num < 0) {
      throw new Error(`Keryx config field bandThresholds.${key} must be a non-negative number`);
    }
    result[key] = num;
  }
  return result;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
