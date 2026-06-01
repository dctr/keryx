import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export interface KeryxConfigFields {
  board: string;
  pollIntervalMs: number;
  defaultAssignee: string;
  defaultDeliveryTarget: string | null;
  localOnly: boolean;
  hermesBin: string;
  host: string;
  port: number;
}

export interface KeryxConfig extends KeryxConfigFields {
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
  pollIntervalMs: 30_000,
  defaultAssignee: 'default',
  defaultDeliveryTarget: null,
  localOnly: true,
  hermesBin: 'hermes',
  host: '127.0.0.1',
  port: 4173,
});

const CONFIG_FILE_NAME = 'keryx.config.json';

export function loadConfig(options: LoadConfigOptions = {}): KeryxConfig {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const configPath = resolveConfigPath({ configPath: options.configPath, env, cwd });
  const fileConfig = configPath ? readConfigFile(configPath) : {};
  const merged = validateConfig({ ...DEFAULT_KERYX_CONFIG, ...fileConfig, ...options.overrides });
  const hermesHome = options.overrides?.hermesHome ?? env.HERMES_HOME;

  return {
    ...merged,
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

function readConfigFile(configPath: string): Partial<KeryxConfigFields> {
  const parsed = JSON.parse(readFileSync(configPath, 'utf8')) as unknown;

  if (!isPlainObject(parsed)) {
    throw new Error(`Keryx config must be a JSON object: ${configPath}`);
  }

  return parsed as Partial<KeryxConfigFields>;
}

function validateConfig(candidate: Partial<KeryxConfigFields>): KeryxConfigFields {
  const config = { ...DEFAULT_KERYX_CONFIG, ...candidate };

  assertNonEmptyString(config.board, 'board');
  assertPositiveInteger(config.pollIntervalMs, 'pollIntervalMs');
  assertNonEmptyString(config.defaultAssignee, 'defaultAssignee');
  if (config.defaultDeliveryTarget !== null) {
    assertNonEmptyString(config.defaultDeliveryTarget, 'defaultDeliveryTarget');
  }
  if (typeof config.localOnly !== 'boolean') {
    throw new Error('Keryx config field localOnly must be a boolean');
  }
  assertNonEmptyString(config.hermesBin, 'hermesBin');
  assertNonEmptyString(config.host, 'host');
  assertPort(config.port);

  return config;
}

function assertNonEmptyString(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`Keryx config field ${field} must be a non-empty string`);
  }
}

function assertPositiveInteger(value: unknown, field: string): asserts value is number {
  if (!Number.isInteger(value) || Number(value) <= 0) {
    throw new Error(`Keryx config field ${field} must be a positive integer`);
  }
}

function assertPort(value: unknown): asserts value is number {
  if (!Number.isInteger(value) || Number(value) <= 0 || Number(value) > 65_535) {
    throw new Error('Keryx config field port must be an integer between 1 and 65535');
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
