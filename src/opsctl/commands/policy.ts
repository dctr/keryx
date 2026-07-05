// policy command group: show, validate, propose, revoke, scan.

import type { HermesCliAdapter } from '../../hermes/adapter';
import { parseCommentBody } from '../../hermes/commentBody';
import { deriveBand, type Band, type TrackRecord } from '../../policy/confidence';
import { computePromotionIntents, type PromotionIntent } from '../../policy/promotion';
import { loadPolicy, writePolicy } from '../../policy/policyStore';
import { aggregateTrackRecord, splitTrackRecordKey, trackRecordKey } from '../../policy/trackRecord';
import type { ActionItem, SourceRef } from '../../schemas/actionItem';
import { validateActionItem } from '../../schemas/actionItem';
import { validateDismissalDecision } from '../../schemas/dismissalDecision';
import type { ExecutionDecision } from '../../schemas/executionDecision';
import { validateExecutionDecision } from '../../schemas/executionDecision';
import { validateRegret } from '../../schemas/regret';
import type { Policy, PolicyRule } from '../../schemas/policy';
import { validatePolicy } from '../../schemas/policy';
import type { CommandResult } from '../output';
import { fail, formatValidationErrors, json, ok } from '../output';
import { collectorSource, parseJsonFile, type CommandContext, type ParsedArgs, type RunOpsctlOptions, stringFlag } from '../shared';
import { buildOutcome } from './cards';

// ---------------------------------------------------------------------------
// policyCommand dispatcher
// ---------------------------------------------------------------------------

export async function policyCommand(ctx: CommandContext): Promise<CommandResult> {
  const { parsed, adapter, options, now } = ctx;
  const subcommand = parsed.positionals[0];
  switch (subcommand) {
    case 'show':
      return policyShow(parsed, adapter, options);
    case 'validate':
      return policyValidate(parsed.positionals[1]);
    case 'propose':
      return policyPropose(parsed.positionals[1], adapter, now);
    case 'revoke':
      return policyRevoke(parsed, adapter, options, now);
    case 'scan':
      return policyScan(parsed, adapter, options, now);
    case 'apply':
      return policyApply(parsed, adapter, options, now);
    default:
      return fail('FAIL policy requires one of: show, validate, propose, revoke, scan, apply', 2);
  }
}

// ---------------------------------------------------------------------------
// policy show
// ---------------------------------------------------------------------------

interface PolicyShowClassRecord extends TrackRecord {
  band: Band;
  approved_since_reset: number;
  overridden_since_reset: number;
  latest_reset: {
    kind: ResetKind;
    at: string | null;
  } | null;
}

async function policyShow(parsed: ParsedArgs, adapter: HermesCliAdapter, options: RunOpsctlOptions): Promise<CommandResult> {
  const collector = parsed.positionals[1];
  if (!collector) {
    return fail('FAIL policy show requires a collector (e.g. keryx-email)', 2);
  }

  const loaded = loadPolicy(collector, { hermesHome: options.config?.hermesHome, env: options.env, now: options.now });
  if (!loaded.ok) {
    return fail(`FAIL invalid policy: ${loaded.path}\n${formatValidationErrors(loaded.errors)}`);
  }

  // Bands are derived live from the Kanban audit trail (§7.7) rather than trusting the
  // policy file's cached track_record. Scope the scan to this collector's tenant.
  const tasks = await adapter.listTasksWithComments({ source: collectorSource(collector) });
  const aggregated = aggregateTrackRecord(tasks);
  const resetEvidence = computeResetEvidence(tasks, collector);

  const scopedByClass: Record<string, TrackRecord> = {};
  for (const [key, record] of Object.entries(aggregated)) {
    const parts = splitTrackRecordKey(key);
    if (parts.collector !== collector) continue;
    scopedByClass[parts.class] = record;
  }

  // Surface every class that has scoped history OR appears in a rule, so a freshly-proposed
  // rule shows its (cold) band even before any execution lands.
  const classes = new Set<string>([...Object.keys(scopedByClass), ...loaded.policy.rules.map((rule) => rule.class)]);
  const derived: Record<string, PolicyShowClassRecord> = {};
  for (const cls of classes) {
    const record = scopedByClass[cls] ?? { approved: 0, overridden: 0, dismissed: 0, regret: 0 };
    const latestReset = resetEvidence[cls];
    derived[cls] = {
      ...record,
      band: deriveBand(record),
      approved_since_reset: record.approved,
      overridden_since_reset: record.overridden,
      latest_reset: latestReset
        ? {
            kind: latestReset.kind,
            at: latestReset.at,
          }
        : null,
    };
  }

  if (parsed.flags.get('json') === true) {
    return ok(
      json({
        collector: loaded.policy.collector,
        exists: loaded.exists,
        version: loaded.policy.version,
        rules: loaded.policy.rules,
        track_record: derived,
      }),
    );
  }

  return ok(formatPolicyShow(loaded.policy.collector, loaded.exists, loaded.policy.rules, derived));
}

function formatPolicyShow(
  collector: string,
  exists: boolean,
  rules: PolicyRule[],
  trackRecord: Record<string, PolicyShowClassRecord>,
): string {
  const lines: string[] = [`policy: ${collector}${exists ? '' : ' (no policy file; defaults shown)'}`];

  lines.push('', `rules (${rules.length}):`);
  if (rules.length === 0) {
    lines.push('  (none — everything resolves to review)');
  } else {
    for (const rule of rules) {
      lines.push(
        `  ${rule.id}  [${rule.state}]  ${rule.disposition}  class=${rule.class}  ` +
          `gate=${rule.gate.max_blast_radius}/${rule.gate.min_reversibility}/${rule.gate.min_confidence}`,
      );
    }
  }

  const classes = Object.keys(trackRecord).sort();
  lines.push('', `track record (${classes.length}):`);
  if (classes.length === 0) {
    lines.push('  (no history yet)');
  } else {
    for (const cls of classes) {
      const record = trackRecord[cls];
      const latestReset = record.latest_reset ? `${record.latest_reset.kind}@${record.latest_reset.at ?? 'unknown'}` : 'none';
      lines.push(
        `  ${cls}  band=${record.band}  approved_since_reset=${record.approved_since_reset} ` +
          `overridden_since_reset=${record.overridden_since_reset} dismissed=${record.dismissed} regret=${record.regret} latest_reset=${latestReset}`,
      );
    }
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// policy validate
// ---------------------------------------------------------------------------

function policyValidate(filePath: string | undefined): CommandResult {
  if (!filePath) {
    return fail('FAIL policy validate requires a JSON file path', 2);
  }

  const validation = validatePolicy(parseJsonFile(filePath));
  if (!validation.ok) {
    return fail(`FAIL invalid policy: ${filePath}\n${formatValidationErrors(validation.errors)}`);
  }

  return ok(`OK valid policy: ${validation.value.collector}`);
}

// ---------------------------------------------------------------------------
// policy propose
// ---------------------------------------------------------------------------

function buildPolicyProposalCard(policy: Policy, rule: PolicyRule, now: () => Date): ActionItem {
  const source = collectorSource(policy.collector);
  return {
    schema: 'keryx.action_item.v2',
    source,
    collector: policy.collector,
    class: 'policy:rule-proposal',
    external_id: `policy-proposal:${policy.collector}:${rule.id}`,
    idempotency_key: `keryx:policy-proposal:${policy.collector}:${rule.id}`,
    origin_descriptor: `Policy proposal for ${policy.collector}`,
    title: `Promote ${rule.class} to ${rule.disposition} (${rule.state}) for ${policy.collector}`,
    summary:
      `Proposed ${rule.disposition} rule ${rule.id} for class ${rule.class} on ${policy.collector}. ` +
      `Gate: blast_radius<=${rule.gate.max_blast_radius}, reversibility<=${rule.gate.min_reversibility}, ` +
      `confidence>=${rule.gate.min_confidence}. Approving writes this rule (state=${rule.state}); dismissing rejects it.`,
    urgency: 'normal',
    proposed_disposition: 'review',
    deadline: null,
    risk: 'Approving grants the collector a standing autonomy rule. Review the gate and state before approving.',
    source_refs: [
      {
        type: 'policy-rule',
        collector: policy.collector,
        rule_id: rule.id,
        class: rule.class,
        state: rule.state,
        disposition: rule.disposition,
      },
      {
        type: 'policy-rule-data',
        collector: policy.collector,
        rule_id: rule.id,
        class: rule.class,
        state: rule.state,
        disposition: rule.disposition,
        result_delivery: rule.result_delivery ?? 'digest',
        gate_max_blast_radius: rule.gate.max_blast_radius,
        gate_min_reversibility: rule.gate.min_reversibility,
        gate_min_confidence: rule.gate.min_confidence,
        source_card_id: rule.source_card_id,
        scope_note: rule.scope_note,
      },
    ],
    options: [
      {
        id: 'approve_rule',
        label: `Write ${rule.state} rule ${rule.id}`,
        requires_input: false,
        input_hint: null,
        delivery: null,
        reversibility: 'reversible',
        blast_radius: 'self',
        undo_prompt: `Remove rule ${rule.id} from ${policy.collector}'s references/policy.json to revert this promotion.`,
        execution_prompt: `Run hermes keryx policy apply <task_id> to deterministically apply this approved policy proposal.`,
      },
    ],
    ui: { primary_option_id: 'approve_rule', display_group: 'Policy proposals' },
    created_at: now().toISOString(),
  };
}

// `policy propose` (PRD §7.7, §11.1): no rule activates without a human-approved card.
// Validate the proposed policy document, then create a blocked action_item.v2 suggestion
// card whose option, once approved, writes the rule into the collector's policy file. The
// proposed rule travels in the card body so the approving worker has the exact rule to
// persist — it is data, never executable instruction, until a human approves.
async function policyPropose(filePath: string | undefined, adapter: HermesCliAdapter, now: () => Date): Promise<CommandResult> {
  if (!filePath) {
    return fail('FAIL policy propose requires a JSON file path', 2);
  }

  const validation = validatePolicy(parseJsonFile(filePath));
  if (!validation.ok) {
    return fail(`FAIL invalid policy proposal: ${filePath}\n${formatValidationErrors(validation.errors)}`);
  }

  const policy = validation.value;
  const rule = policy.rules[0];
  if (!rule) {
    return fail('FAIL policy propose requires at least one rule in the proposal document');
  }

  const card = buildPolicyProposalCard(policy, rule, now);
  const cardValidation = validateActionItem(card);
  if (!cardValidation.ok) {
    return fail(`FAIL generated policy-proposal card is invalid\n${formatValidationErrors(cardValidation.errors)}`);
  }

  return ok(json(await adapter.createTaskFromActionItem(card)));
}

// ---------------------------------------------------------------------------
// policy revoke
// ---------------------------------------------------------------------------

function buildPolicyRevocationCard(collector: string, rule: PolicyRule, now: () => Date): ActionItem {
  const source = collectorSource(collector);
  return {
    schema: 'keryx.action_item.v2',
    source,
    collector,
    class: 'policy:rule-revocation',
    external_id: `policy-revocation:${collector}:${rule.id}`,
    idempotency_key: `keryx:policy-revocation:${collector}:${rule.id}`,
    origin_descriptor: `Policy revocation for ${collector}`,
    title: `Revoke ${rule.disposition} rule ${rule.id} (${rule.class}) on ${collector}`,
    summary:
      `Revoke rule ${rule.id} for class ${rule.class} on ${collector} (currently ${rule.state}). ` +
      `Approving removes the rule from references/policy.json; dismissing keeps it.`,
    urgency: 'normal',
    proposed_disposition: 'review',
    deadline: null,
    risk: 'Revoking a rule removes a standing autonomy grant. The class falls back to review-only handling.',
    source_refs: [
      {
        type: 'policy-rule',
        collector,
        rule_id: rule.id,
        class: rule.class,
        state: rule.state,
        disposition: rule.disposition,
      },
      {
        type: 'policy-rule-data',
        collector,
        rule_id: rule.id,
        class: rule.class,
        state: rule.state,
        disposition: rule.disposition,
        result_delivery: rule.result_delivery ?? 'digest',
        gate_max_blast_radius: rule.gate.max_blast_radius,
        gate_min_reversibility: rule.gate.min_reversibility,
        gate_min_confidence: rule.gate.min_confidence,
        source_card_id: rule.source_card_id,
        scope_note: rule.scope_note,
      },
    ],
    options: [
      {
        id: 'revoke_rule',
        label: `Remove rule ${rule.id}`,
        requires_input: false,
        input_hint: null,
        delivery: null,
        reversibility: 'reversible',
        blast_radius: 'self',
        undo_prompt: `Re-add rule ${rule.id} to ${collector}'s references/policy.json (state=${rule.state}) to restore this grant.`,
        execution_prompt: 'Run hermes keryx policy apply <task_id> to deterministically apply this approved policy revocation.',
      },
    ],
    ui: { primary_option_id: 'revoke_rule', display_group: 'Policy proposals' },
    created_at: now().toISOString(),
  };
}

// `policy revoke <collector> --rule <id>` (PRD §7.7, §9): revocation is itself an auditable
// human-approved change. Rather than silently editing the policy file, this creates a blocked
// suggestion card whose approved option removes the named rule from the collector's policy.
async function policyRevoke(
  parsed: ParsedArgs,
  adapter: HermesCliAdapter,
  options: RunOpsctlOptions,
  now: () => Date,
): Promise<CommandResult> {
  const collector = parsed.positionals[1];
  if (!collector) {
    return fail('FAIL policy revoke requires a collector (e.g. keryx-email)', 2);
  }

  const ruleId = stringFlag(parsed, 'rule');
  if (!ruleId) {
    return fail('FAIL policy revoke requires --rule <id>', 2);
  }

  const loaded = loadPolicy(collector, { hermesHome: options.config?.hermesHome, env: options.env, now: options.now });
  if (!loaded.ok) {
    return fail(`FAIL invalid policy: ${loaded.path}\n${formatValidationErrors(loaded.errors)}`);
  }

  const rule = loaded.policy.rules.find((candidate) => candidate.id === ruleId);
  if (!rule) {
    return fail(`FAIL policy revoke: no rule ${ruleId} in ${loaded.policy.collector}'s policy`);
  }

  const card = buildPolicyRevocationCard(loaded.policy.collector, rule, now);
  const cardValidation = validateActionItem(card);
  if (!cardValidation.ok) {
    return fail(`FAIL generated policy-revocation card is invalid\n${formatValidationErrors(cardValidation.errors)}`);
  }

  return ok(json(await adapter.createTaskFromActionItem(card)));
}

interface PolicyRuleDataRef {
  collector: string;
  rule_id: string;
  class: string;
  state: 'shadow' | 'active';
  disposition: 'silent' | 'review' | 'interrupt';
  result_delivery: 'digest' | 'push' | 'log_only';
  gate_max_blast_radius: 'self' | 'external';
  gate_min_reversibility: 'read_only' | 'reversible' | 'compensable' | 'irreversible';
  gate_min_confidence: Band;
  source_card_id: string | null;
  scope_note: string | null;
}

function sourceRefOfType(sourceRefs: SourceRef[], type: string): SourceRef | null {
  return sourceRefs.find((ref) => ref.type === type) ?? null;
}

function isBand(value: string): value is Band {
  return value === 'cold' || value === 'warming' || value === 'trusted';
}

function sourceRefRuleData(sourceRefs: SourceRef[]): PolicyRuleDataRef | null {
  const ref = sourceRefOfType(sourceRefs, 'policy-rule-data');
  if (!ref) return null;

  const collector = typeof ref.collector === 'string' ? ref.collector : null;
  const ruleId = typeof ref.rule_id === 'string' ? ref.rule_id : null;
  const cls = typeof ref.class === 'string' ? ref.class : null;
  const state = ref.state === 'shadow' || ref.state === 'active' ? ref.state : null;
  const disposition = ref.disposition === 'silent' || ref.disposition === 'review' || ref.disposition === 'interrupt' ? ref.disposition : null;
  const resultDelivery = ref.result_delivery === 'digest' || ref.result_delivery === 'push' || ref.result_delivery === 'log_only' ? ref.result_delivery : null;
  const maxBlast = ref.gate_max_blast_radius === 'self' || ref.gate_max_blast_radius === 'external' ? ref.gate_max_blast_radius : null;
  const minReversibility =
    ref.gate_min_reversibility === 'read_only' ||
    ref.gate_min_reversibility === 'reversible' ||
    ref.gate_min_reversibility === 'compensable' ||
    ref.gate_min_reversibility === 'irreversible'
      ? ref.gate_min_reversibility
      : null;
  const minConfidence = typeof ref.gate_min_confidence === 'string' && isBand(ref.gate_min_confidence) ? ref.gate_min_confidence : null;

  if (!collector || !ruleId || !cls || !state || !disposition || !resultDelivery || !maxBlast || !minReversibility || !minConfidence) {
    return null;
  }

  return {
    collector,
    rule_id: ruleId,
    class: cls,
    state,
    disposition,
    result_delivery: resultDelivery,
    gate_max_blast_radius: maxBlast,
    gate_min_reversibility: minReversibility,
    gate_min_confidence: minConfidence,
    source_card_id: typeof ref.source_card_id === 'string' ? ref.source_card_id : null,
    scope_note: typeof ref.scope_note === 'string' ? ref.scope_note : null,
  };
}

function sourceRefRuleIdentity(sourceRefs: SourceRef[]): { ruleId: string | null; className: string | null } {
  const ref = sourceRefOfType(sourceRefs, 'policy-rule');
  if (!ref) {
    return { ruleId: null, className: null };
  }
  return {
    ruleId: typeof ref.rule_id === 'string' ? ref.rule_id : null,
    className: typeof ref.class === 'string' ? ref.class : null,
  };
}

function sourceRefScanTargetState(sourceRefs: SourceRef[]): 'shadow' | 'active' | 'revoked' | null {
  const ref = sourceRefOfType(sourceRefs, 'policy-scan-intent');
  if (!ref) return null;
  if (ref.target_state === 'shadow' || ref.target_state === 'active' || ref.target_state === 'revoked') {
    return ref.target_state;
  }
  return null;
}

function parseTimestampValue(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value > 1_000_000_000_000 ? value : value * 1000;
  }
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function latestTrustedHumanExecutionDecision(task: Awaited<ReturnType<HermesCliAdapter['showTask']>>): ExecutionDecision | null {
  const comments = task.comments ?? [];
  let latestDecision: ExecutionDecision | null = null;
  let latestAt: number | undefined;
  let latestIndex = -1;

  for (let index = 0; index < comments.length; index += 1) {
    const comment = comments[index];
    const parsed = parseCommentBody(comment);
    if (parsed === null) continue;
    const decision = validateExecutionDecision(parsed);
    if (!decision.ok) continue;
    const value = decision.value;

    const approvedBy = value.approved_by.toLowerCase();
    const approvedVia = value.approved_via.toLowerCase();
    const trustedHuman = !approvedBy.startsWith('keryx') && !approvedVia.startsWith('policy:') && approvedVia !== 'keryx-default-resolver';
    if (!trustedHuman) continue;

    const at = parseTimestampValue(comment.created_at) ?? parseTimestampValue(value.approved_at);
    const shouldReplace =
      latestDecision === null ||
      (at !== undefined && latestAt !== undefined && at >= latestAt) ||
      (at !== undefined && latestAt === undefined) ||
      (at === undefined && latestAt === undefined && index >= latestIndex);

    if (shouldReplace) {
      latestDecision = value;
      latestAt = at;
      latestIndex = index;
    }
  }

  return latestDecision;
}

function normalisedCollector(collector: string): string {
  return collector.startsWith('keryx-') ? collector : `keryx-${collector}`;
}

function nextRuleId(baseClass: string, existingRules: PolicyRule[]): string {
  const stem = baseClass
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  const base = `r-${stem || 'rule'}`;
  if (!existingRules.some((rule) => rule.id === base)) {
    return base;
  }

  let suffix = 2;
  while (existingRules.some((rule) => rule.id === `${base}-${suffix}`)) {
    suffix += 1;
  }
  return `${base}-${suffix}`;
}

function applyPolicyMutation(
  card: ActionItem,
  existingPolicy: Policy,
  decision: ExecutionDecision,
  taskId: string,
  now: () => Date,
): { ok: true; policy: Policy } | { ok: false; message: string } {
  const refs = card.source_refs;
  const ruleData = sourceRefRuleData(refs);
  const identity = sourceRefRuleIdentity(refs);
  const targetState = sourceRefScanTargetState(refs);
  const collector = normalisedCollector(card.collector);

  if (existingPolicy.collector !== collector) {
    return { ok: false, message: `collector mismatch between task (${collector}) and policy file (${existingPolicy.collector})` };
  }

  if (card.class === 'policy:rule-revocation') {
    const ruleId = ruleData?.rule_id ?? identity.ruleId;
    const className = ruleData?.class ?? identity.className;
    const nextRules = existingPolicy.rules.filter((rule) => {
      if (ruleId && rule.id === ruleId) return false;
      if (!ruleId && className && rule.class === className) return false;
      return true;
    });
    if (nextRules.length === existingPolicy.rules.length) {
      return { ok: false, message: 'policy revocation proposal did not resolve to an existing rule' };
    }
    return {
      ok: true,
      policy: {
        ...existingPolicy,
        version: existingPolicy.version + 1,
        updated_at: now().toISOString(),
        rules: nextRules,
      },
    };
  }

  const className = ruleData?.class ?? identity.className;
  if (!className) {
    return { ok: false, message: 'proposal is missing structured rule class in source_refs' };
  }

  const resolvedState: 'shadow' | 'active' =
    card.class === 'policy:rule-demotion'
      ? 'shadow'
      : targetState === 'shadow' || targetState === 'active'
        ? targetState
        : ruleData?.state ?? 'active';

  if (!ruleData && card.class === 'policy:rule-proposal') {
    return { ok: false, message: 'policy proposal is missing structured rule data in source_refs (type=policy-rule-data)' };
  }

  const disposition = ruleData?.disposition ?? 'silent';
  const resultDelivery = ruleData?.result_delivery ?? 'digest';
  const gate = {
    max_blast_radius: ruleData?.gate_max_blast_radius ?? 'self',
    min_reversibility: ruleData?.gate_min_reversibility ?? 'reversible',
    min_confidence: ruleData?.gate_min_confidence ?? 'trusted',
  };

  const ruleId = ruleData?.rule_id ?? identity.ruleId;
  const existingByIdIndex = ruleId ? existingPolicy.rules.findIndex((rule) => rule.id === ruleId) : -1;
  const existingByClassIndex = existingPolicy.rules.findIndex((rule) => rule.class === className);
  const nextId = ruleId ?? (existingByClassIndex >= 0 ? existingPolicy.rules[existingByClassIndex].id : nextRuleId(className, existingPolicy.rules));

  if (card.class === 'policy:rule-demotion' && existingByIdIndex < 0 && existingByClassIndex < 0) {
    return { ok: false, message: 'policy demotion proposal did not resolve to an existing rule' };
  }

  const nextRule: PolicyRule = {
    id: nextId,
    class: className,
    gate,
    disposition,
    result_delivery: resultDelivery,
    state: resolvedState,
    approved_by: decision.approved_by,
    approved_at: decision.approved_at,
    source_card_id: taskId,
    scope_note: ruleData?.scope_note ?? null,
  };

  const nextRules = [...existingPolicy.rules];
  if (existingByIdIndex >= 0) {
    nextRules[existingByIdIndex] = nextRule;
  } else if (existingByClassIndex >= 0) {
    nextRules[existingByClassIndex] = nextRule;
  } else {
    nextRules.push(nextRule);
  }

  return {
    ok: true,
    policy: {
      ...existingPolicy,
      version: existingPolicy.version + 1,
      updated_at: now().toISOString(),
      rules: nextRules,
    },
  };
}

async function policyApply(
  parsed: ParsedArgs,
  adapter: HermesCliAdapter,
  options: RunOpsctlOptions,
  now: () => Date,
): Promise<CommandResult> {
  const taskId = parsed.positionals[1];
  if (!taskId) {
    return fail('FAIL policy apply requires a task id', 2);
  }

  const task = await adapter.showTask(taskId);
  if (typeof task.body !== 'string') {
    return fail(`FAIL policy apply: task ${taskId} has no JSON body`);
  }

  let parsedBody: unknown;
  try {
    parsedBody = JSON.parse(task.body) as unknown;
  } catch (error) {
    return fail(`FAIL policy apply: task ${taskId} body is not valid JSON (${error instanceof Error ? error.message : String(error)})`);
  }

  const card = validateActionItem(parsedBody);
  if (!card.ok) {
    return fail(`FAIL policy apply: task ${taskId} is not a valid keryx.action_item.v2\n${formatValidationErrors(card.errors)}`);
  }

  if (!['policy:rule-proposal', 'policy:rule-revocation', 'policy:rule-demotion'].includes(card.value.class)) {
    return fail(`FAIL policy apply: task ${taskId} class ${card.value.class} is not an approved policy proposal class`);
  }

  const decision = latestTrustedHumanExecutionDecision(task);
  if (!decision) {
    return fail(`FAIL policy apply: task ${taskId} is missing a trusted human keryx.execution_decision.v1 comment`);
  }

  const expectedOptionId = card.value.ui?.primary_option_id ?? card.value.options[0]?.id;
  if (!expectedOptionId || decision.selected_option_id !== expectedOptionId) {
    return fail(
      `FAIL policy apply: latest trusted human decision selected ${decision.selected_option_id}, expected ${expectedOptionId ?? '(none)'}`,
    );
  }

  const loaded = loadPolicy(card.value.collector, { hermesHome: options.config?.hermesHome, env: options.env, now: options.now });
  if (!loaded.ok) {
    return fail(`FAIL invalid policy: ${loaded.path}\n${formatValidationErrors(loaded.errors)}`);
  }

  const applied = applyPolicyMutation(card.value, loaded.policy, decision, taskId, now);
  if (!applied.ok) {
    return fail(`FAIL policy apply: ${applied.message}`);
  }

  const policyValidation = validatePolicy(applied.policy);
  if (!policyValidation.ok) {
    return fail(`FAIL policy apply produced invalid policy\n${formatValidationErrors(policyValidation.errors)}`);
  }

  const writeResult = writePolicy(policyValidation.value, {
    hermesHome: options.config?.hermesHome,
    env: options.env,
  });
  if (!writeResult.ok) {
    return fail(`FAIL policy apply could not write policy\n${formatValidationErrors(writeResult.errors)}`);
  }

  const outcome = buildOutcome(
    {
      executed_option_id: decision.selected_option_id,
      result_summary: `Applied ${card.value.class} for ${card.value.collector}; policy version is now ${policyValidation.value.version}.`,
      result_delivery: 'log_only',
      digest_category: null,
      changed_state: 'collector policy updated',
      delivered_via: 'keryx-policy-apply',
    },
    now,
  );

  await adapter.commentTask(taskId, JSON.stringify(outcome));
  await adapter.completeTask(taskId, `Applied ${card.value.class} for ${card.value.collector}; policy version ${policyValidation.value.version}`);

  return ok(
    json({
      task_id: taskId,
      collector: policyValidation.value.collector,
      class: card.value.class,
      version: policyValidation.value.version,
      path: writeResult.path,
    }),
  );
}

// ---------------------------------------------------------------------------
// policy scan
// ---------------------------------------------------------------------------

type ResetKind = 'dismissal' | 'regret';

interface ResetEvidence {
  kind: ResetKind;
  at: string | null;
  trigger: string;
  timestamp?: number;
  sequence: number;
}

interface PolicyScanIntent {
  kind: PromotionIntent['kind'];
  class: string;
  band: Band;
  currentState: PromotionIntent['currentState'];
  targetState: PromotionIntent['targetState'];
  ruleId: string | null;
  approved: number;
  overridden: number;
  dismissed: number;
  regret: number;
  latestReset: Omit<ResetEvidence, 'sequence' | 'timestamp'> | null;
  riskBounds: {
    max_blast_radius: 'self' | 'external';
    min_reversibility: 'read_only' | 'reversible' | 'compensable' | 'irreversible';
    min_confidence: Band;
  };
  exclusions: string;
  digestBehavior: 'digest' | 'push' | 'log_only';
  revocationPath: string;
}

function parseTimestamp(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value > 1_000_000_000_000 ? value : value * 1000;
  }
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function resetEventTimestamp(task: { created_at?: unknown; updated_at?: unknown }, comment: { created_at?: unknown }): number | undefined {
  return parseTimestamp(comment.created_at) ?? parseTimestamp(task.updated_at) ?? parseTimestamp(task.created_at);
}

function computeResetEvidence(tasks: Awaited<ReturnType<HermesCliAdapter['listTasksWithComments']>>, collector: string): Record<string, ResetEvidence> {
  const evidenceByClass: Record<string, ResetEvidence> = {};
  let sequence = 0;

  for (const task of tasks) {
    if (typeof task.body !== 'string') continue;
    let parsedBody: unknown;
    try {
      parsedBody = JSON.parse(task.body) as unknown;
    } catch {
      continue;
    }

    const card = validateActionItem(parsedBody);
    if (!card.ok || card.value.collector !== collector) {
      continue;
    }

    for (const comment of task.comments ?? []) {
      const body = parseCommentBody(comment);
      if (body === null) continue;

      let kind: ResetKind | null = null;
      let trigger = 'reset event';

      const dismissal = validateDismissalDecision(body);
      if (dismissal.ok) {
        kind = 'dismissal';
        trigger = `dismissed item ${dismissal.value.dismissed_external_id}`;
      } else {
        const regret = validateRegret(body);
        if (regret.ok) {
          kind = 'regret';
          trigger = `regret signal ${regret.value.kind}`;
        }
      }

      if (kind === null) continue;

      const timestamp = resetEventTimestamp(task as { created_at?: unknown; updated_at?: unknown }, comment);
      const candidate: ResetEvidence = {
        kind,
        at: timestamp !== undefined ? new Date(timestamp).toISOString() : null,
        trigger,
        timestamp,
        sequence: sequence++,
      };
      const current = evidenceByClass[card.value.class];
      if (!current) {
        evidenceByClass[card.value.class] = candidate;
        continue;
      }

      const candidateTs = candidate.timestamp;
      const currentTs = current.timestamp;
      if (candidateTs !== undefined && currentTs !== undefined) {
        if (candidateTs >= currentTs) {
          evidenceByClass[card.value.class] = candidate;
        }
        continue;
      }
      if (candidateTs !== undefined && currentTs === undefined) {
        evidenceByClass[card.value.class] = candidate;
        continue;
      }
      if (candidateTs === undefined && currentTs === undefined && candidate.sequence >= current.sequence) {
        evidenceByClass[card.value.class] = candidate;
      }
    }
  }

  return evidenceByClass;
}

function defaultRiskBounds(): PolicyScanIntent['riskBounds'] {
  return {
    max_blast_radius: 'self',
    min_reversibility: 'reversible',
    min_confidence: 'trusted',
  };
}

function scanIntentToCard(
  collector: string,
  intent: PolicyScanIntent,
  rules: PolicyRule[],
  now: () => Date,
): ActionItem {
  const source = collectorSource(collector);
  const existingRule = intent.ruleId ? rules.find((rule) => rule.id === intent.ruleId) : undefined;
  const targetState = intent.targetState;
  const className =
    intent.kind === 'promote'
      ? 'policy:rule-proposal'
      : targetState === 'revoked'
        ? 'policy:rule-revocation'
        : 'policy:rule-demotion';
  const actionVerb =
    intent.kind === 'promote'
      ? `promote ${intent.class} to ${targetState}`
      : targetState === 'revoked'
        ? `revoke active rule for ${intent.class}`
        : `demote ${intent.class} from active to shadow`;
  const title = `${intent.kind === 'promote' ? 'Policy graduation' : 'Policy demotion'}: ${intent.class} -> ${targetState}`;
  const resetSummary = intent.latestReset
    ? `${intent.latestReset.kind} at ${intent.latestReset.at ?? 'unknown time'} (${intent.latestReset.trigger})`
    : 'none';
  const evidenceSummary = `approved=${intent.approved}, overridden=${intent.overridden}, dismissed=${intent.dismissed}, regret=${intent.regret}, latest_reset=${resetSummary}`;
  const fallback = 'If applied, future matching cards without active coverage fall back to review.';

  return {
    schema: 'keryx.action_item.v2',
    source,
    collector,
    class: className,
    external_id: `policy-scan:${collector}:${intent.class}:${targetState}`,
    idempotency_key: `keryx:policy-scan:${collector}:${intent.class}:${targetState}`,
    origin_descriptor: `Policy scan proposal for ${collector}`,
    title,
    summary:
      `${actionVerb}. Evidence: ${evidenceSummary}. ` +
      `Risk bounds: blast_radius<=${intent.riskBounds.max_blast_radius}, reversibility<=${intent.riskBounds.min_reversibility}, confidence>=${intent.riskBounds.min_confidence}. ` +
      `Exclusions: ${intent.exclusions}. Digest behavior: ${intent.digestBehavior}. ${fallback} Undo/correction path: ${intent.revocationPath}`,
    urgency: 'normal',
    proposed_disposition: 'review',
    deadline: null,
    risk:
      'Policy scan proposals change standing autonomy. Review evidence, risk bounds, exclusions, and fallback behavior before approving.',
    source_refs: [
      {
        type: 'policy-scan-intent',
        collector,
        class: intent.class,
        kind: intent.kind,
        current_state: intent.currentState ?? 'none',
        target_state: intent.targetState,
        rule_id: intent.ruleId ?? 'new',
      },
      {
        type: 'policy-rule-data',
        collector,
        rule_id: existingRule?.id ?? intent.ruleId ?? `r-${intent.class.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '')}`,
        class: intent.class,
        state: targetState === 'revoked' ? 'active' : targetState,
        disposition: existingRule?.disposition ?? 'silent',
        result_delivery: existingRule?.result_delivery ?? intent.digestBehavior,
        gate_max_blast_radius: existingRule?.gate.max_blast_radius ?? intent.riskBounds.max_blast_radius,
        gate_min_reversibility: existingRule?.gate.min_reversibility ?? intent.riskBounds.min_reversibility,
        gate_min_confidence: existingRule?.gate.min_confidence ?? intent.riskBounds.min_confidence,
        source_card_id: existingRule?.source_card_id ?? null,
        scope_note: existingRule?.scope_note ?? null,
      },
      ...(existingRule
        ? [
            {
              type: 'policy-rule',
              collector,
              rule_id: existingRule.id,
              class: existingRule.class,
              state: existingRule.state,
              disposition: existingRule.disposition,
            },
          ]
        : []),
    ],
    options: [
      {
        id: 'apply_scan_proposal',
        label: `Apply policy scan proposal (${targetState})`,
        requires_input: false,
        input_hint: null,
        delivery: null,
        reversibility: 'reversible',
        blast_radius: 'self',
        undo_prompt: intent.revocationPath,
        execution_prompt:
          `Run hermes keryx policy apply <task_id> to deterministically apply this approved proposal. ` +
          `If policy apply is unavailable, execute the documented revocation path: ${intent.revocationPath}`,
      },
    ],
    ui: { primary_option_id: 'apply_scan_proposal', display_group: 'Policy proposals' },
    created_at: now().toISOString(),
  };
}

function formatPolicyScan(collector: string, preview: boolean, intents: PolicyScanIntent[]): string {
  if (intents.length === 0) {
    return `OK policy scan ${preview ? 'preview' : 'run'}: no proposals for ${collector}`;
  }

  const lines: string[] = [
    `policy scan ${preview ? 'preview' : 'run'}: ${collector}`,
    `proposals: ${intents.length}`,
  ];
  intents.forEach((intent, index) => {
    const reset = intent.latestReset
      ? `${intent.latestReset.kind}@${intent.latestReset.at ?? 'unknown'} (${intent.latestReset.trigger})`
      : 'none';
    lines.push(
      `${index + 1}. ${intent.kind} class=${intent.class} ${intent.currentState ?? 'none'}->${intent.targetState} band=${intent.band}`,
      `   evidence approved=${intent.approved} overridden=${intent.overridden} dismissed=${intent.dismissed} regret=${intent.regret} latest_reset=${reset}`,
      `   bounds blast<=${intent.riskBounds.max_blast_radius} reversibility<=${intent.riskBounds.min_reversibility} confidence>=${intent.riskBounds.min_confidence}`,
      `   digest=${intent.digestBehavior} exclusions=${intent.exclusions}`,
    );
  });
  return lines.join('\n');
}

async function policyScan(
  parsed: ParsedArgs,
  adapter: HermesCliAdapter,
  options: RunOpsctlOptions,
  now: () => Date,
): Promise<CommandResult> {
  const collector = parsed.positionals[1];
  if (!collector) {
    return fail('FAIL policy scan requires a collector (e.g. keryx-email)', 2);
  }

  const preview = parsed.flags.get('preview') === true;
  const asJson = parsed.flags.get('json') === true;

  const loaded = loadPolicy(collector, { hermesHome: options.config?.hermesHome, env: options.env, now: options.now });
  if (!loaded.ok) {
    return fail(`FAIL invalid policy: ${loaded.path}\n${formatValidationErrors(loaded.errors)}`);
  }

  const tasks = await adapter.listTasksWithComments({ source: collectorSource(collector) });
  const aggregated = aggregateTrackRecord(tasks);
  const resetEvidence = computeResetEvidence(tasks, collector);
  const intents = computePromotionIntents(aggregated, loaded.policy.rules, collector)
    .filter((intent) => loaded.exists || !(intent.kind === 'promote' && intent.currentState === null && intent.targetState === 'shadow'))
    .map((intent): PolicyScanIntent => {
      const record = aggregated[trackRecordKey(collector, intent.class)] ?? { approved: 0, overridden: 0, dismissed: 0, regret: 0 };
      const rule = intent.ruleId ? loaded.policy.rules.find((candidate) => candidate.id === intent.ruleId) : undefined;
      const latestReset = resetEvidence[intent.class];

      return {
        kind: intent.kind,
        class: intent.class,
        band: intent.band,
        currentState: intent.currentState,
        targetState: intent.targetState,
        ruleId: intent.ruleId,
        approved: record.approved,
        overridden: record.overridden,
        dismissed: record.dismissed,
        regret: record.regret,
        latestReset: latestReset
          ? {
              kind: latestReset.kind,
              at: latestReset.at,
              trigger: latestReset.trigger,
            }
          : null,
        riskBounds: rule?.gate ?? defaultRiskBounds(),
        exclusions:
          'Never silent for money, destructive, or credential-gated operations; execute-time floor checks still apply.',
        digestBehavior: rule?.result_delivery ?? 'digest',
        revocationPath: `Run hermes keryx policy revoke ${collector} --rule ${intent.ruleId ?? '<new-rule-id>'} to reverse this grant.`,
      };
    });

  if (preview) {
    if (asJson) {
      return ok(
        json({
          collector,
          preview: true,
          policy_exists: loaded.exists,
          proposals: intents,
        }),
      );
    }
    return ok(formatPolicyScan(collector, true, intents));
  }

  const created: unknown[] = [];
  for (const intent of intents) {
    const card = scanIntentToCard(collector, intent, loaded.policy.rules, now);
    const cardValidation = validateActionItem(card);
    if (!cardValidation.ok) {
      return fail(`FAIL generated policy-scan card is invalid\n${formatValidationErrors(cardValidation.errors)}`);
    }
    created.push(await adapter.createTaskFromActionItem(card));
  }

  if (asJson) {
    return ok(
      json({
        collector,
        preview: false,
        policy_exists: loaded.exists,
        proposals: intents,
        created,
      }),
    );
  }

  return ok(`OK policy scan created ${created.length} proposal card(s) for ${collector}`);
}
