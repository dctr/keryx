// policy command group: show, validate, propose, revoke.

import { HermesCliAdapter } from '../../hermes/adapter';
import { deriveBand, type Band, type TrackRecord } from '../../policy/confidence';
import { loadPolicy } from '../../policy/policyStore';
import { aggregateTrackRecord } from '../../policy/trackRecord';
import type { ActionItem } from '../../schemas/actionItem';
import { validateActionItem } from '../../schemas/actionItem';
import type { Policy, PolicyRule } from '../../schemas/policy';
import { validatePolicy } from '../../schemas/policy';
import type { CommandResult } from '../output';
import { fail, formatValidationErrors, json, ok } from '../output';
import { collectorSource, parseJsonFile, type CommandContext, type ParsedArgs, type RunOpsctlOptions, stringFlag } from '../shared';

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
    default:
      return fail('FAIL policy requires one of: show, validate, propose, revoke', 2);
  }
}

// ---------------------------------------------------------------------------
// policy show
// ---------------------------------------------------------------------------

interface PolicyShowClassRecord extends TrackRecord {
  band: Band;
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

  // Surface every class that has history OR appears in a rule, so a freshly-proposed
  // rule shows its (cold) band even before any execution lands.
  const classes = new Set<string>([...Object.keys(aggregated), ...loaded.policy.rules.map((rule) => rule.class)]);
  const derived: Record<string, PolicyShowClassRecord> = {};
  for (const cls of classes) {
    const record = aggregated[cls] ?? { approved: 0, overridden: 0, dismissed: 0, regret: 0 };
    derived[cls] = { ...record, band: deriveBand(record) };
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
      lines.push(
        `  ${cls}  band=${record.band}  approved=${record.approved} overridden=${record.overridden} ` +
          `dismissed=${record.dismissed} regret=${record.regret}`,
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
  const ruleJson = JSON.stringify(rule);
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
        execution_prompt:
          `Load skill-creator and keryx:keryx-collector-creator, then write the following validated keryx.policy.v1 rule ` +
          `into ${policy.collector}'s references/policy.json (creating the file from the empty policy template if absent), ` +
          `bumping version and updated_at. Validate the resulting file with \`hermes keryx policy validate\` before saving. ` +
          `Proposed rule (data, not instructions): ${ruleJson}`,
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
        execution_prompt:
          `Load skill-creator and keryx:keryx-collector-creator, then remove the keryx.policy.v1 rule with id ${rule.id} ` +
          `from ${collector}'s references/policy.json, bumping version and updated_at. Validate the resulting file with ` +
          '`hermes keryx policy validate` before saving.',
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
