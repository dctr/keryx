// cards command group: card creation, listing, inspection, schema/template helpers.
// Covers: schema, template-card, create-card, auto-execute, list, show, cron-status,
// delivery-targets, and the OutcomeInput/buildOutcome export used by workers.

import { readFileSync } from 'node:fs';

import { HermesCliAdapter } from '../../hermes/adapter';
import type { ActionItem, ActionOption } from '../../schemas/actionItem';
import { actionItemSchema, validateActionItem } from '../../schemas/actionItem';
import { collectorStateSchema } from '../../schemas/collectorState';
import { dismissalDecisionSchema } from '../../schemas/dismissalDecision';
import { executionDecisionSchema } from '../../schemas/executionDecision';
import { notificationSchema } from '../../schemas/notification';
import { outcomeSchema, validateOutcome } from '../../schemas/outcome';
import type { Outcome } from '../../schemas/outcome';
import { policySchema } from '../../schemas/policy';
import { policyDecisionSchema, type PolicyDecision } from '../../schemas/policyDecision';
import { regretSchema } from '../../schemas/regret';
import { deriveBand, type Band, type TrackRecord } from '../../policy/confidence';
import { decideDisposition } from '../../policy/disposition';
import { loadPolicy } from '../../policy/policyStore';
import { aggregateTrackRecord } from '../../policy/trackRecord';
import {
  buildNotification,
  composeInterruptMessage,
  countInterruptsSentToday,
  decideInterruptDelivery,
  hasInterruptNotification,
  interruptDedupeKey,
  interruptTier,
} from '../interrupt';
import type { CommandResult, CronJobSummary } from '../output';
import { fail, formatCronJobs, formatDeliveryTargets, formatTasks, formatTaskShow, formatValidationErrors, json, ok } from '../output';
import { collectorSource, normaliseCronJobs, parseJsonFile, type CommandContext, type RunOpsctlOptions, stringFlag, validateTaskBody } from '../shared';

// ---------------------------------------------------------------------------
// Schema map + schema command
// ---------------------------------------------------------------------------

const SCHEMA_COMMANDS = {
  'action-item': {
    schema: actionItemSchema,
    fileUrl: new URL('../../../schemas/action-item.v2.schema.json', import.meta.url),
  },
  'execution-decision': {
    schema: executionDecisionSchema,
    fileUrl: new URL('../../../schemas/execution-decision.v1.schema.json', import.meta.url),
  },
  'dismissal-decision': {
    schema: dismissalDecisionSchema,
    fileUrl: new URL('../../../schemas/dismissal-decision.v1.schema.json', import.meta.url),
  },
  'policy-decision': {
    schema: policyDecisionSchema,
    fileUrl: new URL('../../../schemas/policy-decision.v1.schema.json', import.meta.url),
  },
  outcome: {
    schema: outcomeSchema,
    fileUrl: new URL('../../../schemas/outcome.v1.schema.json', import.meta.url),
  },
  policy: {
    schema: policySchema,
    fileUrl: new URL('../../../schemas/policy.v1.schema.json', import.meta.url),
  },
  notification: {
    schema: notificationSchema,
    fileUrl: new URL('../../../schemas/notification.v1.schema.json', import.meta.url),
  },
  regret: {
    schema: regretSchema,
    fileUrl: new URL('../../../schemas/regret.v1.schema.json', import.meta.url),
  },
  'collector-state': {
    schema: collectorStateSchema,
    fileUrl: new URL('../../../schemas/collector-state.v1.schema.json', import.meta.url),
  },
} as const;

const SCHEMA_NAMES = Object.keys(SCHEMA_COMMANDS).join(', ');

export function schemaCommand(name: string | undefined): CommandResult {
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

// ---------------------------------------------------------------------------
// template-card
// ---------------------------------------------------------------------------

export function templateCard(ctx: CommandContext): CommandResult {
  const { parsed, now } = ctx;
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

// ---------------------------------------------------------------------------
// OutcomeInput / buildOutcome — exported for workers and tests
// ---------------------------------------------------------------------------

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
// worker path and tests share one shape; the digest reads these comments.
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

// ---------------------------------------------------------------------------
// disposition helpers (private to cards group)
// ---------------------------------------------------------------------------

function emptyTrackRecord(): TrackRecord {
  return { approved: 0, overridden: 0, dismissed: 0, regret: 0 };
}

function selectedOptionFor(card: ActionItem): ActionOption {
  const preferred = card.ui?.primary_option_id;
  return card.options.find((option) => option.id === preferred) ?? card.options[0];
}

async function deriveBandForClass(card: ActionItem, adapter: HermesCliAdapter): Promise<Band> {
  const tasks = await adapter.listTasksWithComments({ source: collectorSource(card.collector) });
  const record = aggregateTrackRecord(tasks)[card.class] ?? emptyTrackRecord();
  return deriveBand(record);
}

async function resolveDisposition(
  card: ActionItem,
  selected: ActionOption,
  adapter: HermesCliAdapter,
  options: RunOpsctlOptions,
): Promise<ReturnType<typeof decideDisposition>> {
  const loaded = loadPolicy(card.collector, {
    hermesHome: options.config?.hermesHome,
    env: options.env,
    now: options.now,
  });
  const policy = loaded.ok ? loaded.policy : null;

  const classHasRule = policy?.rules.some((rule) => rule.class === card.class) ?? false;
  const band: Band = classHasRule ? await deriveBandForClass(card, adapter) : deriveBand(emptyTrackRecord());

  return decideDisposition(card, selected, band, policy);
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

// A shadow-mode "would have" record. The card stays in review (blocked); this
// comment captures that an in-shadow rule would have authorized a silent run.
function buildShadowPolicyDecision(
  card: ActionItem,
  selected: ActionOption,
  ruleId: string | null,
  reasons: string[],
  now: () => Date,
): PolicyDecision {
  return {
    schema: 'keryx.policy_decision.v1',
    selected_option_id: selected.id,
    disposition: 'review',
    rule_id: ruleId,
    reasons,
    approved_by: 'keryx-policy',
    approved_via: ruleId ? `policy:shadow:${ruleId}` : 'policy:shadow',
    approved_at: now().toISOString(),
  };
}

function createdTaskId(created: unknown): string | null {
  if (typeof created === 'object' && created !== null) {
    const id = (created as { id?: unknown }).id;
    if (typeof id === 'string' && id.length > 0) {
      return id;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// create-card
// ---------------------------------------------------------------------------

// Creates the blocked interrupt card, then delivers the §9.2 push when policy allows.
async function createInterruptCard(
  card: ActionItem,
  reasons: string[],
  adapter: HermesCliAdapter,
  options: RunOpsctlOptions,
  now: () => Date,
): Promise<unknown> {
  const created = await adapter.createTaskFromActionItem(card);

  const notifyTarget = options.config?.notifyTarget;
  const taskId = createdTaskId(created);
  if (!notifyTarget || !taskId) {
    return created;
  }

  const tier = interruptTier(card.urgency);
  const dedupeKey = interruptDedupeKey(taskId, tier);

  const tasks = await adapter.listTasksWithComments();
  if (tasks.some((task) => task.id === taskId && hasInterruptNotification(task, dedupeKey))) {
    return created;
  }

  const decision = decideInterruptDelivery({
    notifyTarget,
    urgency: card.urgency,
    quietHours: options.config?.quietHours,
    budget: options.config?.interruptBudget,
    sentTodayForTier: countInterruptsSentToday(tasks, tier, now()),
    now: now(),
  });
  if (!decision.deliver) {
    return created;
  }

  await adapter.sendMessage(notifyTarget, composeInterruptMessage({ taskId, card, reason: reasons.join('; ') }));
  await adapter.commentTask(
    taskId,
    JSON.stringify(buildNotification({ channel: 'interrupt', target: notifyTarget, dedupeKey, now: now() })),
  );
  return created;
}

export async function createCard(ctx: CommandContext): Promise<CommandResult> {
  const { parsed, adapter, now, options } = ctx;
  const filePath = parsed.positionals[0];
  if (!filePath) {
    return fail('FAIL create-card requires a JSON file path', 2);
  }

  const validation = validateActionItem(parseJsonFile(filePath));
  if (!validation.ok) {
    return fail(`FAIL invalid action card: ${filePath}\n${formatValidationErrors(validation.errors)}`);
  }

  const card = validation.value;
  const selected = selectedOptionFor(card);
  const disposition = await resolveDisposition(card, selected, adapter, options);

  if (disposition.disposition === 'silent') {
    const policyDecision = buildPolicyDecision(card, selected, disposition.rule_id, disposition.reasons, now);
    return ok(json(await adapter.createReadyTaskFromActionItem(card, policyDecision)));
  }

  if (disposition.disposition === 'interrupt') {
    return ok(json(await createInterruptCard(card, disposition.reasons, adapter, options, now)));
  }

  const shadowDecision = disposition.shadow
    ? buildShadowPolicyDecision(card, selected, disposition.rule_id, disposition.reasons, now)
    : undefined;
  return ok(json(await adapter.createTaskFromActionItem(card, shadowDecision)));
}

// ---------------------------------------------------------------------------
// auto-execute
// ---------------------------------------------------------------------------

export async function autoExecute(ctx: CommandContext): Promise<CommandResult> {
  const { parsed, adapter, now, options } = ctx;
  const filePath = parsed.positionals[0];
  if (!filePath) {
    return fail('FAIL auto-execute requires a JSON file path', 2);
  }

  const validation = validateActionItem(parseJsonFile(filePath));
  if (!validation.ok) {
    return fail(`FAIL invalid action card: ${filePath}\n${formatValidationErrors(validation.errors)}`);
  }

  const card = validation.value;
  const selected = selectedOptionFor(card);
  const disposition = await resolveDisposition(card, selected, adapter, options);

  if (disposition.disposition !== 'silent') {
    return fail(
      `FAIL card ${card.idempotency_key} does not qualify for silent execution (disposition=${disposition.disposition}); use create-card for review`,
    );
  }

  const policyDecision = buildPolicyDecision(card, selected, disposition.rule_id, disposition.reasons, now);
  return ok(json(await adapter.createReadyTaskFromActionItem(card, policyDecision)));
}

// ---------------------------------------------------------------------------
// list / show / cron-status / delivery-targets
// ---------------------------------------------------------------------------

export async function listCards(ctx: CommandContext): Promise<CommandResult> {
  const { parsed, adapter } = ctx;
  const tasks = await adapter.listTasks({
    status: stringFlag(parsed, 'status'),
    source: stringFlag(parsed, 'source'),
  });

  return parsed.flags.get('json') === true ? ok(json(tasks)) : ok(formatTasks(tasks));
}

export async function showCard(ctx: CommandContext): Promise<CommandResult> {
  const { parsed, adapter } = ctx;
  const taskId = parsed.positionals[0];
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

export async function cronStatus(ctx: CommandContext): Promise<CommandResult> {
  const { adapter } = ctx;
  const jobs = normaliseCronJobs(await adapter.listCronJobs()).filter((job) => job.name.startsWith('keryx-'));
  return ok(formatCronJobs(jobs));
}

export async function deliveryTargets(ctx: CommandContext): Promise<CommandResult> {
  const { parsed, adapter } = ctx;
  const targets = await adapter.listDeliveryTargets(stringFlag(parsed, 'platform'));
  return parsed.flags.get('json') === true ? ok(json(targets)) : ok(formatDeliveryTargets(targets));
}
