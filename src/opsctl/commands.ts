import { accessSync, constants, existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { type KeryxConfig, loadConfig } from '../config';
import { HermesCliAdapter, parseHermesVersion } from '../hermes/adapter';
import type { HermesRunner, KanbanTask } from '../hermes/types';
import { deriveBand, type TrackRecord } from '../policy/confidence';
import { decideDisposition } from '../policy/disposition';
import { actionItemSchema, type ActionItem, type ActionOption, validateActionItem } from '../schemas/actionItem';
import { collectorStateSchema, validateCollectorState } from '../schemas/collectorState';
import { dismissalDecisionSchema, validateDismissalDecision } from '../schemas/dismissalDecision';
import { executionDecisionSchema, validateExecutionDecision } from '../schemas/executionDecision';
import { notificationSchema } from '../schemas/notification';
import { outcomeSchema, validateOutcome } from '../schemas/outcome';
import type { Outcome } from '../schemas/outcome';
import { policySchema, validatePolicy } from '../schemas/policy';
import { policyDecisionSchema, type PolicyDecision, validatePolicyDecision } from '../schemas/policyDecision';
import { regretSchema } from '../schemas/regret';
import {
  type CommandResult,
  type CronJobSummary,
  type DoctorLine,
  fail,
  formatCronJobs,
  formatDeliveryTargets,
  formatDoctorLines,
  formatTaskShow,
  formatTasks,
  formatValidationErrors,
  json,
  ok,
} from './output';

export interface RunOpsctlOptions {
  config?: KeryxConfig;
  configPath?: string | null;
  cwd?: string;
  env?: Record<string, string | undefined>;
  hermesRunner?: HermesRunner;
  now?: () => Date;
}

interface ParsedArgs {
  command: string;
  positionals: string[];
  flags: Map<string, string | boolean>;
}

const HELP_TEXT = `Usage: opsctl <command> [options]

Read-only commands:
  doctor                         Check Keryx config and Hermes reachability
  list [--status <status>]       List Keryx Kanban cards
  show <task_id>                 Show a Keryx Kanban card and validate its JSON body
  cron-status                    Summarise keryx-* collector cron jobs
  delivery-targets [--json]      List Hermes delivery targets
  schema <action-item|execution-decision|dismissal-decision|policy-decision|outcome|policy|notification|regret|collector-state>
                                  Print a canonical Keryx JSON schema
  template-card [--source <source>] [--collector <collector>]
                                  Print a schema-valid action-item template
  validate-card <file>           Validate an action-item JSON card body
  validate-decision <file>       Validate an execution-decision JSON comment body
  validate-state <file>          Validate a collector-state JSON file
  validate-policy-decision <file>  Validate a policy-decision JSON comment body
  validate-outcome <file>        Validate an outcome JSON comment body
  validate-policy <file>         Validate a collector policy JSON document
  validate-dismissal <file>      Validate a dismissal-decision JSON comment body

Mutating commands:
  create-card <file>              Validate and create a blocked Keryx Kanban card
  auto-execute <file>             Validate, derive disposition, and create a silent ready card (read_only only in Phase 3)
  execute <task_id> --option <id> [--feedback <text>] [--dispatch]
                                  Append the user's execution decision and promote a card
  dismiss <task_id> [--reason <text>]
                                  Append an exact-item dismissal and archive a card

Global options:
  --help, -h                     Show this help
`;

// The Keryx plugin surface is written against Hermes 0.16. The doctor enforces this as
// the minimum supported Hermes CLI version. Kept here as a named code constant (not in
// the README, which is intentionally version-neutral) so docs and enforcement stay
// decoupled.
const MINIMUM_HERMES_VERSION = '0.16.0';
const COLLECTOR_CREATOR_BUNDLE_FILE = 'keryx-collector-creator.yaml';
const COLLECTOR_CREATOR_BUNDLE_COMMAND = '/keryx-collector-creator';
const COLLECTOR_CREATOR_PLUGIN_SKILL = 'keryx:keryx-collector-creator';

const SCHEMA_COMMANDS = {
  'action-item': {
    schema: actionItemSchema,
    fileUrl: new URL('../../schemas/action-item.v2.schema.json', import.meta.url),
  },
  'execution-decision': {
    schema: executionDecisionSchema,
    fileUrl: new URL('../../schemas/execution-decision.v1.schema.json', import.meta.url),
  },
  'dismissal-decision': {
    schema: dismissalDecisionSchema,
    fileUrl: new URL('../../schemas/dismissal-decision.v1.schema.json', import.meta.url),
  },
  'policy-decision': {
    schema: policyDecisionSchema,
    fileUrl: new URL('../../schemas/policy-decision.v1.schema.json', import.meta.url),
  },
  outcome: {
    schema: outcomeSchema,
    fileUrl: new URL('../../schemas/outcome.v1.schema.json', import.meta.url),
  },
  policy: {
    schema: policySchema,
    fileUrl: new URL('../../schemas/policy.v1.schema.json', import.meta.url),
  },
  notification: {
    schema: notificationSchema,
    fileUrl: new URL('../../schemas/notification.v1.schema.json', import.meta.url),
  },
  regret: {
    schema: regretSchema,
    fileUrl: new URL('../../schemas/regret.v1.schema.json', import.meta.url),
  },
  'collector-state': {
    schema: collectorStateSchema,
    fileUrl: new URL('../../schemas/collector-state.v1.schema.json', import.meta.url),
  },
} as const;

const SCHEMA_NAMES = Object.keys(SCHEMA_COMMANDS).join(', ');

const PROJECT_ROOT = resolveProjectRoot(dirname(fileURLToPath(import.meta.url)));

export function getHelpText(): string {
  return HELP_TEXT;
}

export async function runOpsctl(argv: string[], options: RunOpsctlOptions = {}): Promise<CommandResult> {
  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
    return ok(HELP_TEXT);
  }

  try {
    const parsed = parseArgs(argv);
    const config = options.config ?? loadConfig({ env: options.env, cwd: options.cwd, configPath: options.configPath });
    const adapter = new HermesCliAdapter(config, options.hermesRunner);

    switch (parsed.command) {
      case 'schema':
        return schemaCommand(parsed.positionals[0]);
      case 'template-card':
        return templateCard(parsed, options.now ?? (() => new Date()));
      case 'validate-card':
        return validateCard(parsed.positionals[0]);
      case 'validate-decision':
        return validateDecision(parsed.positionals[0]);
      case 'validate-state':
        return validateState(parsed.positionals[0]);
      case 'validate-policy-decision':
        return validatePolicyDecisionCommand(parsed.positionals[0]);
      case 'validate-outcome':
        return validateOutcomeCommand(parsed.positionals[0]);
      case 'validate-policy':
        return validatePolicyCommand(parsed.positionals[0]);
      case 'validate-dismissal':
        return validateDismissalCommand(parsed.positionals[0]);
      case 'create-card':
        return await createCard(parsed.positionals[0], adapter, options.now ?? (() => new Date()));
      case 'auto-execute':
        return await autoExecute(parsed.positionals[0], adapter, options.now ?? (() => new Date()));
      case 'list':
        return listCards(parsed, adapter);
      case 'show':
        return showCard(parsed.positionals[0], adapter);
      case 'cron-status':
        return cronStatus(adapter);
      case 'delivery-targets':
        return deliveryTargets(parsed, adapter);
      case 'execute':
        return executeCard(parsed, adapter, options.now ?? (() => new Date()));
      case 'dismiss':
        return dismissCard(parsed, adapter, options.now ?? (() => new Date()));
      case 'doctor':
        return doctor(config, adapter, { cwd: options.cwd ?? process.cwd(), env: options.env ?? process.env });
      default:
        return fail(`Unknown opsctl command: ${parsed.command}\n\n${HELP_TEXT}`, 2);
    }
  } catch (error) {
    return fail(`FAIL ${error instanceof Error ? error.message : String(error)}`);
  }
}

function parseArgs(argv: string[]): ParsedArgs {
  const [command, ...rest] = argv;
  const flags = new Map<string, string | boolean>();
  const positionals: string[] = [];

  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (!token.startsWith('--')) {
      positionals.push(token);
      continue;
    }

    const flagName = token.slice(2);
    if (isBooleanFlag(flagName)) {
      flags.set(flagName, true);
      continue;
    }

    const value = rest[index + 1];
    if (!value || value.startsWith('--')) {
      throw new Error(`Missing value for ${token}`);
    }
    flags.set(flagName, value);
    index += 1;
  }

  return { command, positionals, flags };
}

function schemaCommand(name: string | undefined): CommandResult {
  if (!name || !(name in SCHEMA_COMMANDS)) {
    return fail(`FAIL schema requires one of: ${SCHEMA_NAMES}`, 2);
  }

  const schema = SCHEMA_COMMANDS[name as keyof typeof SCHEMA_COMMANDS];
  const schemaText = readFileSync(schema.fileUrl, 'utf8');
  if (JSON.stringify(JSON.parse(schemaText)) !== JSON.stringify(schema.schema)) {
    return fail(`FAIL schema import does not match repository file: ${name}`);
  }
  return ok(schemaText);
}

function templateCard(parsed: ParsedArgs, now: () => Date): CommandResult {
  const source = stringFlag(parsed, 'source') ?? 'example';
  const collector = stringFlag(parsed, 'collector') ?? `keryx-${source}`;
  const externalId = `${source}:replace-me`;
  const card: ActionItem = {
    schema: 'keryx.action_item.v2',
    source,
    collector,
    class: `${source}:replace-me`,
    external_id: externalId,
    idempotency_key: `keryx:${source}:replace-me`,
    origin_descriptor: `${source} item replace-me`,
    title: `Review ${source} item`,
    summary: 'Replace this summary with compact candidate facts. Do not paste raw private source content.',
    urgency: 'normal',
    proposed_disposition: 'review',
    deadline: null,
    risk: null,
    source_refs: [{ type: source, id: 'replace-me' }],
    options: [
      {
        id: 'approve',
        label: 'Approve requested action',
        requires_input: false,
        input_hint: null,
        delivery: null,
        reversibility: 'reversible',
        blast_radius: 'self',
        undo_prompt: 'Describe how to reverse the approved action if it needs to be undone.',
        execution_prompt: 'Re-query the source system, verify the item still needs action, then perform the approved action safely.',
      },
    ],
    ui: { primary_option_id: 'approve', display_group: 'Needs approval' },
    created_at: now().toISOString(),
  };

  const validation = validateActionItem(card);
  return validation.ok ? ok(json(card)) : fail(`FAIL generated template is invalid\n${formatValidationErrors(validation.errors)}`);
}

function validateCard(filePath: string | undefined): CommandResult {
  if (!filePath) {
    return fail('FAIL validate-card requires a JSON file path', 2);
  }

  const parsed = parseJsonFile(filePath);
  const validation = validateActionItem(parsed);
  if (!validation.ok) {
    return fail(`FAIL invalid action card: ${filePath}\n${formatValidationErrors(validation.errors)}`);
  }

  return ok(`OK valid action card: ${validation.value.title}`);
}

function validateDecision(filePath: string | undefined): CommandResult {
  if (!filePath) {
    return fail('FAIL validate-decision requires a JSON file path', 2);
  }

  const parsed = parseJsonFile(filePath);
  const validation = validateExecutionDecision(parsed);
  if (!validation.ok) {
    return fail(`FAIL invalid execution decision: ${filePath}\n${formatValidationErrors(validation.errors)}`);
  }

  return ok(`OK valid execution decision: ${validation.value.selected_option_id}`);
}

function validateState(filePath: string | undefined): CommandResult {
  if (!filePath) {
    return fail('FAIL validate-state requires a JSON file path', 2);
  }

  const parsed = parseJsonFile(filePath);
  const validation = validateCollectorState(parsed);
  if (!validation.ok) {
    return fail(`FAIL invalid collector state: ${filePath}\n${formatValidationErrors(validation.errors)}`);
  }

  return ok(`OK valid collector state: ${validation.value.source}`);
}

function validatePolicyDecisionCommand(filePath: string | undefined): CommandResult {
  if (!filePath) {
    return fail('FAIL validate-policy-decision requires a JSON file path', 2);
  }

  const validation = validatePolicyDecision(parseJsonFile(filePath));
  if (!validation.ok) {
    return fail(`FAIL invalid policy decision: ${filePath}\n${formatValidationErrors(validation.errors)}`);
  }

  return ok(`OK valid policy decision: ${validation.value.disposition}`);
}

function validateOutcomeCommand(filePath: string | undefined): CommandResult {
  if (!filePath) {
    return fail('FAIL validate-outcome requires a JSON file path', 2);
  }

  const validation = validateOutcome(parseJsonFile(filePath));
  if (!validation.ok) {
    return fail(`FAIL invalid outcome: ${filePath}\n${formatValidationErrors(validation.errors)}`);
  }

  return ok(`OK valid outcome: ${validation.value.executed_option_id}`);
}

function validatePolicyCommand(filePath: string | undefined): CommandResult {
  if (!filePath) {
    return fail('FAIL validate-policy requires a JSON file path', 2);
  }

  const validation = validatePolicy(parseJsonFile(filePath));
  if (!validation.ok) {
    return fail(`FAIL invalid policy: ${filePath}\n${formatValidationErrors(validation.errors)}`);
  }

  return ok(`OK valid policy: ${validation.value.collector}`);
}

function validateDismissalCommand(filePath: string | undefined): CommandResult {
  if (!filePath) {
    return fail('FAIL validate-dismissal requires a JSON file path', 2);
  }

  const validation = validateDismissalDecision(parseJsonFile(filePath));
  if (!validation.ok) {
    return fail(`FAIL invalid dismissal decision: ${filePath}\n${formatValidationErrors(validation.errors)}`);
  }

  return ok(`OK valid dismissal decision: ${validation.value.dismissed_external_id}`);
}

async function createCard(filePath: string | undefined, adapter: HermesCliAdapter, now: () => Date): Promise<CommandResult> {
  if (!filePath) {
    return fail('FAIL create-card requires a JSON file path', 2);
  }

  const validation = validateActionItem(parseJsonFile(filePath));
  if (!validation.ok) {
    return fail(`FAIL invalid action card: ${filePath}\n${formatValidationErrors(validation.errors)}`);
  }

  const card = validation.value;
  const selected = selectedOptionFor(card);
  const disposition = resolveDisposition(card, selected);

  if (disposition.disposition === 'silent') {
    const policyDecision = buildPolicyDecision(card, selected, disposition.rule_id, disposition.reasons, now);
    return ok(json(await adapter.createReadyTaskFromActionItem(card, policyDecision)));
  }

  return ok(json(await adapter.createTaskFromActionItem(card)));
}

// `auto-execute` is the creation+promotion entrypoint used by collectors/tests for a
// card that must run silently. It validates, derives the disposition, and (only when
// silent) creates the ready card plus its policy-decision comment. The Kanban worker —
// not opsctl — performs the side effect and writes the keryx.outcome.v1 comment (§7.4).
async function autoExecute(filePath: string | undefined, adapter: HermesCliAdapter, now: () => Date): Promise<CommandResult> {
  if (!filePath) {
    return fail('FAIL auto-execute requires a JSON file path', 2);
  }

  const validation = validateActionItem(parseJsonFile(filePath));
  if (!validation.ok) {
    return fail(`FAIL invalid action card: ${filePath}\n${formatValidationErrors(validation.errors)}`);
  }

  const card = validation.value;
  const selected = selectedOptionFor(card);
  const disposition = resolveDisposition(card, selected);

  if (disposition.disposition !== 'silent') {
    return fail(
      `FAIL card ${card.idempotency_key} does not qualify for silent execution (disposition=${disposition.disposition}); use create-card for review`,
    );
  }

  const policyDecision = buildPolicyDecision(card, selected, disposition.rule_id, disposition.reasons, now);
  return ok(json(await adapter.createReadyTaskFromActionItem(card, policyDecision)));
}

// Phase 3: no policy store yet (passed null) and an empty track record (cold band).
// Only read_only options reach the silent disposition; everything else stays blocked.
function resolveDisposition(card: ActionItem, selected: ActionOption) {
  return decideDisposition(card, selected, deriveBand(emptyTrackRecord()), null);
}

// Picks the option the disposition function reasons over: the collector-suggested
// primary if it resolves, otherwise the first option (mirrors the UI's selection).
function selectedOptionFor(card: ActionItem): ActionOption {
  const preferred = card.ui?.primary_option_id;
  return card.options.find((option) => option.id === preferred) ?? card.options[0];
}

function emptyTrackRecord(): TrackRecord {
  return { approved: 0, overridden: 0, dismissed: 0, regret: 0 };
}

function buildPolicyDecision(
  card: ActionItem,
  selected: ActionOption,
  ruleId: string | null,
  reasons: string[],
  now: () => Date,
): PolicyDecision {
  return {
    schema: 'keryx.policy_decision.v1',
    selected_option_id: selected.id,
    disposition: 'silent',
    rule_id: ruleId,
    reasons,
    approved_by: 'keryx-policy',
    approved_via: ruleId ? `policy:${ruleId}` : 'policy:read-only',
    approved_at: now().toISOString(),
  };
}

export interface OutcomeInput {
  executed_option_id: string;
  result_summary: string;
  result_delivery: Outcome['result_delivery'];
  digest_category: string | null;
  digest_cadence?: 'daily' | 'weekly';
  changed_state: string | null;
  delivered_via: string | null;
}

// Builds a keryx.outcome.v1 body a silent worker writes on completion. Exported so the
// worker path and tests share one shape; the digest (Task 3.6) reads these comments.
export function buildOutcome(input: OutcomeInput, now: () => Date = () => new Date()): Outcome {
  return {
    schema: 'keryx.outcome.v1',
    executed_option_id: input.executed_option_id,
    result_summary: input.result_summary,
    result_delivery: input.result_delivery,
    digest_category: input.digest_category,
    ...(input.digest_cadence ? { digest_cadence: input.digest_cadence } : {}),
    changed_state: input.changed_state,
    delivered_via: input.delivered_via,
    completed_at: now().toISOString(),
  };
}

async function listCards(parsed: ParsedArgs, adapter: HermesCliAdapter): Promise<CommandResult> {
  const tasks = await adapter.listTasks({
    status: stringFlag(parsed, 'status'),
    source: stringFlag(parsed, 'source'),
  });

  return parsed.flags.get('json') === true ? ok(json(tasks)) : ok(formatTasks(tasks));
}

async function showCard(taskId: string | undefined, adapter: HermesCliAdapter): Promise<CommandResult> {
  if (!taskId) {
    return fail('FAIL show requires a task id', 2);
  }

  const task = await adapter.showTask(taskId);
  const validation = validateTaskBody(task);
  if (!validation.ok) {
    return fail(`FAIL invalid action body for ${task.id}:\n${validation.message}`);
  }

  return ok(formatTaskShow(task, 'OK'));
}

async function cronStatus(adapter: HermesCliAdapter): Promise<CommandResult> {
  const jobs = normaliseCronJobs(await adapter.listCronJobs()).filter((job) => job.name.startsWith('keryx-'));
  return ok(formatCronJobs(jobs));
}

async function deliveryTargets(parsed: ParsedArgs, adapter: HermesCliAdapter): Promise<CommandResult> {
  const targets = await adapter.listDeliveryTargets(stringFlag(parsed, 'platform'));
  return parsed.flags.get('json') === true ? ok(json(targets)) : ok(formatDeliveryTargets(targets));
}

async function executeCard(parsed: ParsedArgs, adapter: HermesCliAdapter, now: () => Date): Promise<CommandResult> {
  const taskId = parsed.positionals[0];
  if (!taskId) {
    return fail('FAIL execute requires a task id', 2);
  }

  const idError = validateTaskIdArgument(taskId);
  if (idError) {
    return idError;
  }

  const selectedOptionId = stringFlag(parsed, 'option');
  if (!selectedOptionId) {
    return fail('FAIL execute requires --option <option_id>', 2);
  }

  const task = await adapter.showTask(taskId);
  const body = parseActionItemFromTask(task);
  if (!body.ok) {
    return fail(`FAIL invalid action body for ${task.id}:\n${body.message}`);
  }

  const selectedOption = body.actionItem.options.find((option) => option.id === selectedOptionId);
  if (!selectedOption) {
    const availableOptions = body.actionItem.options.map((option) => option.id).join(', ') || '(none)';
    return fail(`FAIL invalid option ID ${selectedOptionId} for ${task.id}; available options: ${availableOptions}`);
  }

  const status = normaliseTaskStatus(task);
  if (status === 'ready' || status === 'running' || status === 'done') {
    return ok(
      json({
        ok: true,
        task_id: task.id,
        status,
        action: `already-${status}`,
        selected_option_id: selectedOption.id,
        dispatched: false,
      }),
    );
  }

  if (status !== 'blocked' && status !== 'todo') {
    return fail(`FAIL cannot execute ${task.id} from status ${status}`);
  }

  await adapter.commentTask(task.id, JSON.stringify(buildExecutionDecision(selectedOption.id, stringFlag(parsed, 'feedback') ?? null, now)));
  await adapter.promoteTask(task.id, 'approved from Keryx');

  const shouldDispatch = parsed.flags.get('dispatch') === true;
  if (shouldDispatch) {
    await adapter.dispatch();
  }

  return ok(
    json({
      ok: true,
      task_id: task.id,
      status: 'ready',
      action: 'promoted',
      selected_option_id: selectedOption.id,
      dispatched: shouldDispatch,
    }),
  );
}

async function dismissCard(parsed: ParsedArgs, adapter: HermesCliAdapter, now: () => Date): Promise<CommandResult> {
  const taskId = parsed.positionals[0];
  if (!taskId) {
    return fail('FAIL dismiss requires a task id', 2);
  }

  const idError = validateTaskIdArgument(taskId);
  if (idError) {
    return idError;
  }

  const task = await adapter.showTask(taskId);
  const body = parseActionItemFromTask(task);
  if (!body.ok) {
    return fail(`FAIL invalid action body for ${task.id}:\n${body.message}`);
  }

  const status = normaliseTaskStatus(task);
  if (status === 'archived' || status === 'done') {
    return ok(json(dismissResult(task.id, status, `already-${status}`, body.actionItem)));
  }

  if (status !== 'blocked' && status !== 'todo') {
    return fail(`FAIL cannot dismiss ${task.id} from status ${status}`);
  }

  await adapter.commentTask(task.id, JSON.stringify(buildDismissalDecision(body.actionItem, stringFlag(parsed, 'reason') ?? null, now)));
  await adapter.archiveTask(task.id);

  return ok(json(dismissResult(task.id, 'archived', 'archived', body.actionItem)));
}

function buildExecutionDecision(selectedOptionId: string, userFeedback: string | null, now: () => Date) {
  return {
    schema: 'keryx.execution_decision.v1',
    selected_option_id: selectedOptionId,
    user_feedback: userFeedback,
    approved_by: 'User',
    approved_via: 'keryx-web',
    approved_at: now().toISOString(),
  };
}

function buildDismissalDecision(actionItem: ActionItem, reason: string | null, now: () => Date) {
  return {
    schema: 'keryx.dismissal_decision.v1',
    dismissal_scope: 'exact_item',
    reason,
    dismissed_external_id: actionItem.external_id,
    dismissed_idempotency_key: actionItem.idempotency_key,
    dismissed_by: 'User',
    dismissed_via: 'keryx-web',
    dismissed_at: now().toISOString(),
  };
}

function dismissResult(taskId: string, status: string, action: string, actionItem: ActionItem) {
  return {
    ok: true,
    task_id: taskId,
    status,
    action,
    dismissal_scope: 'exact_item',
    external_id: actionItem.external_id,
    idempotency_key: actionItem.idempotency_key,
  };
}

interface DoctorOptions {
  cwd: string;
  env: Record<string, string | undefined>;
}

async function doctor(config: KeryxConfig, adapter: HermesCliAdapter, options: DoctorOptions): Promise<CommandResult> {
  const lines: DoctorLine[] = [
    { level: 'OK', check: 'config', message: `board=${config.board}; hermes=${config.hermesBin}` },
  ];

  const hermesCliPath = findExecutable(config.hermesBin, options.env);
  if (hermesCliPath) {
    lines.push({ level: 'OK', check: 'hermes-cli', message: `found ${hermesCliPath}` });
    lines.push(await checkHermesVersion(adapter));
  } else {
    lines.push({ level: 'FAIL', check: 'hermes-cli', message: `not executable or not on PATH: ${config.hermesBin}` });
  }

  const hermesHome = resolveHermesHome(config, options.env);
  const pluginCheck = checkInstalledPlugin(hermesHome);
  lines.push(pluginCheck);
  lines.push(checkCollectorCreatorBundle(hermesHome));
  lines.push(checkKanbanDefaultAssignee(hermesHome));

  if (hasInstalledDependencies(PROJECT_ROOT)) {
    lines.push({ level: 'OK', check: 'dependencies', message: 'project dependencies installed' });
  } else {
    lines.push({ level: 'FAIL', check: 'dependencies', message: 'run `npm install` from the Keryx project root' });
  }

  try {
    const blocked = await adapter.listTasks({ status: 'blocked' });
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
  } catch (error) {
    lines.push({ level: 'FAIL', check: 'hermes', message: error instanceof Error ? error.message : String(error) });
  }

  try {
    const deliveryTargets = await adapter.listDeliveryTargets();
    lines.push({
      level: deliveryTargets.length > 0 ? 'OK' : 'WARN',
      check: 'delivery-targets',
      message: deliveryTargets.length > 0 ? `${deliveryTargets.length} target(s) available` : 'no Hermes delivery targets available',
    });
  } catch (error) {
    lines.push({ level: 'FAIL', check: 'delivery-targets', message: error instanceof Error ? error.message : String(error) });
  }

  try {
    const jobs = normaliseCronJobs(await adapter.listCronJobs()).filter((job) => job.name.startsWith('keryx-'));
    lines.push({
      level: jobs.length > 0 ? 'OK' : 'WARN',
      check: 'cron',
      message: jobs.length > 0 ? `${jobs.length} keryx-* collector job(s) visible` : 'no keryx-* collector cron jobs configured',
    });
  } catch (error) {
    lines.push({ level: 'WARN', check: 'cron', message: `could not list cron jobs: ${error instanceof Error ? error.message : String(error)}` });
  }

  return { exitCode: lines.some((line) => line.level === 'FAIL') ? 1 : 0, stdout: formatDoctorLines(lines), stderr: '' };
}

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

// Returns the indented lines belonging to a top-level (column-0) mapping key.
function extractTopLevelBlock(text: string, key: string): string[] {
  const lines = text.split(/\r?\n/);
  const headerIndex = lines.findIndex((line) => new RegExp(`^${key}:\\s*(#.*)?$`).test(line));
  if (headerIndex === -1) {
    return [];
  }

  const block: string[] = [];
  for (let index = headerIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim().length === 0) {
      continue;
    }
    if (leadingSpaces(line) === 0) {
      break;
    }
    block.push(line);
  }
  return block;
}

// Extracts a string list for a key within an already-scoped block, handling both
// flow style (`enabled: [keryx, other]`) and block style (`enabled:` then `- keryx`).
function extractStringList(block: string[], key: string): string[] {
  const keyIndex = block.findIndex((line) => new RegExp(`^\\s*${key}:\\s*`).test(line));
  if (keyIndex === -1) {
    return [];
  }

  const keyLine = block[keyIndex];
  const keyIndent = leadingSpaces(keyLine);
  const inlineValue = keyLine.replace(new RegExp(`^\\s*${key}:\\s*`), '').trim();

  if (inlineValue.startsWith('[')) {
    return parseFlowList(inlineValue);
  }
  if (inlineValue.length > 0 && !inlineValue.startsWith('#')) {
    return [unquote(inlineValue)].filter((entry) => entry.length > 0);
  }

  const items: string[] = [];
  for (let index = keyIndex + 1; index < block.length; index += 1) {
    const line = block[index];
    if (line.trim().length === 0) {
      continue;
    }
    const match = line.match(/^\s*-\s*(.*)$/);
    if (!match) {
      // A non-list line that is indented deeper than the key cannot belong to a
      // YAML block sequence; anything at or below the key's indent is a sibling.
      break;
    }
    // Block sequence items may sit at the same indentation as their parent key
    // (Hermes' own serialiser does this) or be indented further. Only a dash
    // line shallower than the key escapes the current mapping.
    if (leadingSpaces(line) < keyIndent) {
      break;
    }
    const entry = unquote(stripInlineComment(match[1]).trim());
    if (entry.length > 0) {
      items.push(entry);
    }
  }
  return items;
}

function extractStringScalar(block: string[], key: string): string | null {
  const keyLine = block.find((line) => new RegExp(`^\\s*${key}:\\s*`).test(line));
  if (!keyLine) {
    return null;
  }
  const value = stripInlineComment(keyLine.replace(new RegExp(`^\\s*${key}:\\s*`), '')).trim();
  if (!value || value === 'null' || value === '~') {
    return null;
  }
  return unquote(value);
}

function parseFlowList(value: string): string[] {
  const inner = value.slice(value.indexOf('[') + 1, value.lastIndexOf(']'));
  return inner
    .split(',')
    .map((entry) => unquote(entry.trim()))
    .filter((entry) => entry.length > 0);
}

function stripInlineComment(value: string): string {
  const hashIndex = value.indexOf(' #');
  return hashIndex === -1 ? value : value.slice(0, hashIndex);
}

function unquote(value: string): string {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

function leadingSpaces(line: string): number {
  return line.length - line.trimStart().length;
}

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

function parseJsonFile(filePath: string): unknown {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8')) as unknown;
  } catch (error) {
    throw new Error(`invalid JSON file ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function validateTaskBody(task: KanbanTask): { ok: true } | { ok: false; message: string } {
  const parsed = parseActionItemFromTask(task);
  return parsed.ok ? { ok: true } : { ok: false, message: parsed.message };
}

function parseActionItemFromTask(task: KanbanTask): { ok: true; actionItem: ActionItem } | { ok: false; message: string } {
  if (typeof task.body !== 'string') {
    return { ok: false, message: 'task body is not a JSON string' };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(task.body) as unknown;
  } catch (error) {
    return { ok: false, message: `task body is not valid JSON: ${error instanceof Error ? error.message : String(error)}` };
  }

  const validation = validateActionItem(parsed);
  if (!validation.ok) {
    return { ok: false, message: formatValidationErrors(validation.errors) };
  }

  return { ok: true, actionItem: validation.value };
}

function normaliseCronJobs(value: unknown): CronJobSummary[] {
  const candidates = findCronJobCandidates(value);
  return candidates.map(normaliseCronJob).filter((job): job is CronJobSummary => job !== null);
}

function findCronJobCandidates(value: unknown): unknown[] {
  if (Array.isArray(value)) {
    return value;
  }
  if (!isPlainObject(value)) {
    return [];
  }

  for (const key of ['jobs', 'cron_jobs', 'items', 'results']) {
    if (Array.isArray(value[key])) {
      return value[key];
    }
  }

  return Object.values(value).flatMap((entry) => (Array.isArray(entry) ? entry : []));
}

function normaliseCronJob(value: unknown): CronJobSummary | null {
  if (typeof value === 'string') {
    return { name: value, enabled: true };
  }
  if (!isPlainObject(value)) {
    return null;
  }

  const name = firstString(value.name, value.id, value.job_id, value.prompt);
  if (!name) {
    return null;
  }

  return {
    ...(firstString(value.id, value.job_id) ? { id: firstString(value.id, value.job_id) } : {}),
    name,
    enabled: inferCronEnabled(value),
    ...(firstString(value.schedule, value.cron, value.interval) ? { schedule: firstString(value.schedule, value.cron, value.interval) } : {}),
  };
}

function inferCronEnabled(value: Record<string, unknown>): boolean {
  if (typeof value.enabled === 'boolean') {
    return value.enabled;
  }
  if (typeof value.paused === 'boolean') {
    return !value.paused;
  }
  if (typeof value.status === 'string') {
    return !['paused', 'disabled', 'stopped'].includes(value.status.toLowerCase());
  }
  return true;
}

function stringFlag(parsed: ParsedArgs, name: string): string | undefined {
  const value = parsed.flags.get(name);
  return typeof value === 'string' ? value : undefined;
}

function isBooleanFlag(name: string): boolean {
  return name === 'json' || name === 'dispatch';
}

function normaliseTaskStatus(task: KanbanTask): string {
  return typeof task.status === 'string' && task.status.trim().length > 0 ? task.status : 'unknown';
}

// Rejects task ids that begin with "-" (after trimming) so they cannot reach
// Hermes argv as option-lookalikes. Mirrors the API route guard. Returns a
// failing CommandResult (exit 2) when invalid, or undefined when acceptable.
function validateTaskIdArgument(taskId: string): CommandResult | undefined {
  return taskId.trim().startsWith('-') ? fail('FAIL task id must not begin with "-"', 2) : undefined;
}

function firstString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === 'string' && value.trim().length > 0);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
