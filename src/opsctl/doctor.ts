// doctor: Keryx health-check command. Verifies Hermes CLI, plugin installation,
// collector-creator bundle, kanban config, dependencies, and board reachability.

import { accessSync, constants, existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { HermesCliAdapter, parseHermesVersion } from '../hermes/adapter';
import { isPlainObject } from '../util/object';
import type { KeryxConfig } from '../config';
import {
  extractStringList,
  extractStringScalar,
  extractTopLevelBlock,
} from './yamlConfig';
import type { CommandResult, DoctorLine } from './output';
import { formatDoctorLines } from './output';
import { normaliseCronJobs, validateTaskBody } from './shared';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// The Keryx plugin surface is written against Hermes 0.16. The doctor enforces this as
// the minimum supported Hermes CLI version. Kept here as a named code constant (not in
// the README, which is intentionally version-neutral) so docs and enforcement stay
// decoupled.
export const MINIMUM_HERMES_VERSION = '0.16.0';
const COLLECTOR_CREATOR_BUNDLE_FILE = 'keryx-collector-creator.yaml';
const COLLECTOR_CREATOR_BUNDLE_COMMAND = '/keryx-collector-creator';
const COLLECTOR_CREATOR_PLUGIN_SKILL = 'keryx:keryx-collector-creator';

// Lazy: computed on first access to avoid sync dir walk + readFileSync at module load time.
let _projectRoot: string | undefined;
export function getProjectRoot(): string {
  if (_projectRoot === undefined) {
    _projectRoot = resolveProjectRoot(dirname(fileURLToPath(import.meta.url)));
  }
  return _projectRoot;
}

// ---------------------------------------------------------------------------
// doctor
// ---------------------------------------------------------------------------

interface DoctorOptions {
  cwd: string;
  env: Record<string, string | undefined>;
}

export async function doctor(config: KeryxConfig, adapter: HermesCliAdapter, options: DoctorOptions): Promise<CommandResult> {
  const lines: DoctorLine[] = [
    { level: 'OK', check: 'config', message: `board=${config.board}; hermes=${config.hermesBin}` },
  ];

  const hermesCliPath = findExecutable(config.hermesBin, options.env);
  if (hermesCliPath) {
    lines.push({ level: 'OK', check: 'hermes-cli', message: `found ${hermesCliPath}` });
  } else {
    lines.push({ level: 'FAIL', check: 'hermes-cli', message: `not executable or not on PATH: ${config.hermesBin}` });
  }

  // Fan out all 4 independent Hermes reads concurrently. Sync checks run while they are
  // in-flight. Results are emitted below in the SAME fixed order as the original sequential
  // implementation so that integration-test assertions on line ordering are unaffected.
  const versionPromise = hermesCliPath ? checkHermesVersion(adapter) : Promise.resolve(null);
  const blockedPromise = adapter.listTasks({ status: 'blocked' });
  const deliveryPromise = adapter.listDeliveryTargets();
  const cronPromise = adapter.listCronJobs();

  // Sync checks (computed while async reads are in-flight).
  const hermesHome = resolveHermesHome(config, options.env);
  const pluginLine = checkInstalledPlugin(hermesHome);
  const collectorLine = checkCollectorCreatorBundle(hermesHome);
  const kanbanAssigneeLine = checkKanbanDefaultAssignee(hermesHome);
  const dependenciesLine: DoctorLine = hasInstalledDependencies(getProjectRoot())
    ? { level: 'OK', check: 'dependencies', message: 'project dependencies installed' }
    : { level: 'FAIL', check: 'dependencies', message: 'run `npm install` from the Keryx project root' };

  const [versionResult, blockedResult, deliveryResult, cronResult] = await Promise.allSettled([
    versionPromise,
    blockedPromise,
    deliveryPromise,
    cronPromise,
  ]);

  // Emit lines in original fixed order -----------------------------------------

  // hermes-version (only when the CLI was found)
  if (hermesCliPath) {
    if (versionResult.status === 'fulfilled' && versionResult.value !== null) {
      lines.push(versionResult.value);
    } else if (versionResult.status === 'rejected') {
      lines.push({
        level: 'WARN',
        check: 'hermes-version',
        message: `could not determine Hermes version: ${versionResult.reason instanceof Error ? versionResult.reason.message : String(versionResult.reason)}`,
      });
    }
  }

  // plugin / collector-creator / kanban-default-assignee / dependencies (sync)
  lines.push(pluginLine, collectorLine, kanbanAssigneeLine, dependenciesLine);

  // hermes (blocked tasks)
  if (blockedResult.status === 'fulfilled') {
    const blocked = blockedResult.value;
    const invalidBodies = blocked
      .map((task) => ({ task, validation: validateTaskBody(task) }))
      .filter((entry) => !entry.validation.ok);
    if (invalidBodies.length > 0) {
      lines.push({
        level: 'WARN',
        check: 'hermes',
        message: `board ${config.board} reachable, but ${invalidBodies.length}/${blocked.length} blocked cards have invalid Keryx JSON`,
      });
    } else {
      lines.push({ level: 'OK', check: 'hermes', message: `board ${config.board} reachable; ${blocked.length} blocked Keryx cards visible` });
    }
  } else {
    const error = blockedResult.reason;
    lines.push({ level: 'FAIL', check: 'hermes', message: error instanceof Error ? error.message : String(error) });
  }

  // delivery-targets
  if (deliveryResult.status === 'fulfilled') {
    const deliveryTargets = deliveryResult.value;
    lines.push({
      level: deliveryTargets.length > 0 ? 'OK' : 'WARN',
      check: 'delivery-targets',
      message: deliveryTargets.length > 0 ? `${deliveryTargets.length} target(s) available` : 'no Hermes delivery targets available',
    });
  } else {
    const error = deliveryResult.reason;
    lines.push({ level: 'FAIL', check: 'delivery-targets', message: error instanceof Error ? error.message : String(error) });
  }

  // cron
  if (cronResult.status === 'fulfilled') {
    const jobs = normaliseCronJobs(cronResult.value).filter((job) => job.name.startsWith('keryx-'));
    lines.push({
      level: jobs.length > 0 ? 'OK' : 'WARN',
      check: 'cron',
      message: jobs.length > 0 ? `${jobs.length} keryx-* collector job(s) visible` : 'no keryx-* collector cron jobs configured',
    });
  } else {
    const error = cronResult.reason;
    lines.push({ level: 'WARN', check: 'cron', message: `could not list cron jobs: ${error instanceof Error ? error.message : String(error)}` });
  }

  return { exitCode: lines.some((line) => line.level === 'FAIL') ? 1 : 0, stdout: formatDoctorLines(lines), stderr: '' };
}

// ---------------------------------------------------------------------------
// Version check
// ---------------------------------------------------------------------------

// Verifies the Hermes CLI is at least MINIMUM_HERMES_VERSION. Only invoked once the
// hermes binary has been located. Degrades gracefully: a non-zero exit or unparsable
// output yields WARN (cosmetic output changes must not hard-fail the doctor); a parsed
// version below the minimum is the only FAIL path.
async function checkHermesVersion(adapter: HermesCliAdapter): Promise<DoctorLine> {
  let output: string;
  try {
    output = await adapter.getVersion();
  } catch (error) {
    return {
      level: 'WARN',
      check: 'hermes-version',
      message: `could not determine Hermes version: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const version = parseHermesVersion(output);
  if (!version) {
    const firstLine = output.split(/\r?\n/, 1)[0]?.trim() ?? '';
    return {
      level: 'WARN',
      check: 'hermes-version',
      message: `could not parse a version from hermes --version output${firstLine ? `: ${firstLine}` : ''}`,
    };
  }

  if (compareSemver(version, MINIMUM_HERMES_VERSION) < 0) {
    return {
      level: 'FAIL',
      check: 'hermes-version',
      message: `Hermes ${version} is older than the required minimum ${MINIMUM_HERMES_VERSION}; run \`hermes update\``,
    };
  }

  return { level: 'OK', check: 'hermes-version', message: version };
}

// Compares two dotted numeric versions. Returns <0, 0, or >0. Both inputs are assumed to
// be three-part numeric semvers as produced by parseHermesVersion / a literal constant.
function compareSemver(a: string, b: string): number {
  const left = a.split('.').map((part) => Number.parseInt(part, 10));
  const right = b.split('.').map((part) => Number.parseInt(part, 10));
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const diff = (left[index] ?? 0) - (right[index] ?? 0);
    if (diff !== 0) {
      return diff;
    }
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Plugin, bundle, kanban-default-assignee checks
// ---------------------------------------------------------------------------

function resolveHermesHome(config: KeryxConfig, env: Record<string, string | undefined>): string {
  return config.hermesHome ?? env.HERMES_HOME ?? join(env.HOME ?? homedir(), '.hermes');
}

function checkInstalledPlugin(hermesHome: string): DoctorLine {
  const pluginDir = join(hermesHome, 'plugins', 'keryx');
  const missing = ['plugin.yaml', '__init__.py'].filter((relativePath) => !existsSync(join(pluginDir, relativePath)));

  if (missing.length > 0) {
    return { level: 'FAIL', check: 'plugin', message: `missing ${missing.join(', ')} under ${pluginDir}` };
  }

  const enablement = readPluginEnablement(hermesHome);
  const enableGuidance = 'run `hermes plugins enable keryx`';

  if (enablement.disabled.includes('keryx')) {
    return {
      level: 'FAIL',
      check: 'plugin',
      message: `installed but explicitly disabled in ${join(hermesHome, 'config.yaml')}; ${enableGuidance}`,
    };
  }

  if (enablement.enabled.includes('keryx')) {
    return { level: 'OK', check: 'plugin', message: `installed and enabled under ${pluginDir}` };
  }

  return {
    level: 'FAIL',
    check: 'plugin',
    message: `installed but not enabled in ${join(hermesHome, 'config.yaml')}; ${enableGuidance}`,
  };
}

function checkCollectorCreatorBundle(hermesHome: string): DoctorLine {
  const bundlePath = join(hermesHome, 'skill-bundles', COLLECTOR_CREATOR_BUNDLE_FILE);

  if (!existsSync(bundlePath)) {
    return {
      level: 'WARN',
      check: 'collector-creator',
      message: `bundle missing; rerun ./keryx-setup.sh to install ${COLLECTOR_CREATOR_BUNDLE_COMMAND}`,
    };
  }

  let text: string;
  try {
    text = readFileSync(bundlePath, 'utf8');
  } catch {
    return {
      level: 'WARN',
      check: 'collector-creator',
      message: `bundle does not load ${COLLECTOR_CREATOR_PLUGIN_SKILL}; rerun ./keryx-setup.sh --force to restore`,
    };
  }

  const skills = extractStringList(text.split(/\r?\n/), 'skills');
  if (skills.includes(COLLECTOR_CREATOR_PLUGIN_SKILL)) {
    return { level: 'OK', check: 'collector-creator', message: `${COLLECTOR_CREATOR_BUNDLE_COMMAND} bundle installed` };
  }

  return {
    level: 'WARN',
    check: 'collector-creator',
    message: `bundle does not load ${COLLECTOR_CREATOR_PLUGIN_SKILL}; rerun ./keryx-setup.sh --force to restore`,
  };
}

function checkKanbanDefaultAssignee(hermesHome: string): DoctorLine {
  const defaultAssignee = readHermesKanbanDefaultAssignee(hermesHome);
  if (!defaultAssignee) {
    return { level: 'OK', check: 'kanban-default-assignee', message: 'not set' };
  }

  // TODO(https://github.com/NousResearch/hermes-agent/issues/39609): remove this
  // warning when Keryx can return to atomic sticky-blocked creation through Hermes.
  return {
    level: 'WARN',
    check: 'kanban-default-assignee',
    message:
      `kanban.default_assignee=${defaultAssignee}; unset it as a temporary workaround for ` +
      'Hermes issue https://github.com/NousResearch/hermes-agent/issues/39609 because Keryx briefly creates cards before sticky-blocking them',
  };
}

function readHermesKanbanDefaultAssignee(hermesHome: string): string | null {
  let text: string;
  try {
    text = readFileSync(join(hermesHome, 'config.yaml'), 'utf8');
  } catch {
    return null;
  }

  const kanbanBlock = extractTopLevelBlock(text, 'kanban');
  if (kanbanBlock.length === 0) {
    return null;
  }

  return extractStringScalar(kanbanBlock, 'default_assignee');
}

interface PluginEnablement {
  enabled: string[];
  disabled: string[];
}

// Parses $HERMES_HOME/config.yaml for the plugins.enabled / plugins.disabled lists.
// A narrow YAML-subset reader is preferred over a new Hermes CLI shape (AGENTS.md
// forbids generic Hermes passthroughs). A missing or unreadable config yields empty
// lists, which the caller treats as "not enabled".
function readPluginEnablement(hermesHome: string): PluginEnablement {
  let text: string;
  try {
    text = readFileSync(join(hermesHome, 'config.yaml'), 'utf8');
  } catch {
    return { enabled: [], disabled: [] };
  }

  const pluginsBlock = extractTopLevelBlock(text, 'plugins');
  if (pluginsBlock.length === 0) {
    return { enabled: [], disabled: [] };
  }

  return {
    enabled: extractStringList(pluginsBlock, 'enabled'),
    disabled: extractStringList(pluginsBlock, 'disabled'),
  };
}

// ---------------------------------------------------------------------------
// File system utilities
// ---------------------------------------------------------------------------

function findExecutable(bin: string, env: Record<string, string | undefined>): string | undefined {
  if (bin.includes('/')) {
    return isExecutable(bin) ? bin : undefined;
  }

  for (const directory of (env.PATH ?? '').split(delimiter)) {
    if (!directory) {
      continue;
    }
    const candidate = join(directory, bin);
    if (isExecutable(candidate)) {
      return candidate;
    }
  }

  return undefined;
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function hasInstalledDependencies(projectRoot: string): boolean {
  return existsSync(join(projectRoot, 'package.json')) && existsSync(join(projectRoot, 'node_modules'));
}

function resolveProjectRoot(startDirectory: string): string {
  let current = startDirectory;

  while (true) {
    const packagePath = join(current, 'package.json');
    if (existsSync(packagePath)) {
      try {
        const parsed = JSON.parse(readFileSync(packagePath, 'utf8')) as unknown;
        if (isPlainObject(parsed) && parsed.name === 'keryx') {
          return current;
        }
      } catch {
        // Keep walking; a parent package.json may still identify the repo root.
      }
    }

    const parent = dirname(current);
    if (parent === current) {
      return startDirectory;
    }
    current = parent;
  }
}
