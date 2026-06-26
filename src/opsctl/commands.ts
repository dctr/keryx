// commands.ts — thin dispatcher. Owns: runOpsctl, parseArgs, getHelpText, HELP_TEXT,
// flag helpers (isBooleanFlag), RunOpsctlOptions, ParsedArgs (re-exported from shared).
// All command logic lives in the neighbouring modules:
//   src/opsctl/commands/validate.ts
//   src/opsctl/commands/cards.ts
//   src/opsctl/commands/lifecycle.ts
//   src/opsctl/commands/undo.ts
//   src/opsctl/commands/policy.ts
//   src/opsctl/commands/metricsCmd.ts
//   src/opsctl/commands/digestCmd.ts
//   src/opsctl/commands/defaultResolveCmd.ts
//   src/opsctl/commands/regretCmd.ts
//   src/opsctl/doctor.ts

import { type KeryxConfig, loadConfig } from '../config';
import { HermesCliAdapter } from '../hermes/adapter';
import { type CommandResult, fail, ok } from './output';
import { type ParsedArgs, type RunOpsctlOptions } from './shared';

// Re-export the public interface types and buildOutcome so existing importers
// (server/app.ts, tests/unit/opsctl-auto-execute.test.ts) do not break.
export type { RunOpsctlOptions } from './shared';
export { type OutcomeInput, buildOutcome } from './commands/cards';

import {
  validateCard,
  validateDecision,
  validateState,
  validatePolicyDecisionCommand,
  validateOutcomeCommand,
  validatePolicyCommand,
  validateDismissalCommand,
} from './commands/validate';

import {
  schemaCommand,
  templateCard,
  createCard,
  autoExecute,
  listCards,
  showCard,
  cronStatus,
  deliveryTargets,
} from './commands/cards';

import { executeCard, dismissCard, markReviewedCard } from './commands/lifecycle';
import { undoCard } from './commands/undo';
import { policyCommand } from './commands/policy';
import { metricsCmd } from './commands/metricsCmd';
import { digestCmd } from './commands/digestCmd';
import { defaultResolveCmd } from './commands/defaultResolveCmd';
import { regretCmd } from './commands/regretCmd';
import { doctor } from './doctor';

// ---------------------------------------------------------------------------
// Help text
// ---------------------------------------------------------------------------

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
  mark-reviewed <task_id>         Mark a done review-log card reviewed and archive it
  digest [--preview] [--cadence daily|weekly]
                                  Render the relevancy-grouped digest of silent outcomes (--preview only for now)
  default-resolve [--preview]     Execute default_on_timeout for interrupt cards past their deadline with no decision
  metrics [--window <range>] [--json]
                                  Report attention-economics metrics derived from the Kanban audit trail
  regret <task_id> --kind <should_have_acted|should_have_asked> [--note <text>]
                                  Record an escalation-regret signal on a card (feeds confidence bands)
  undo <task_id>                  Honestly reverse/correct an executed card per its reversibility
                                  (reversible -> reversal card; compensable -> labeled correction; irreversible -> corrective triage)
  policy show <collector> [--json]
                                  Show a collector's active/shadow rules and derived track-record bands
  policy validate <file>          Validate a collector policy JSON document
  policy propose <file>           Create a human-approval card that writes a proposed policy rule
  policy revoke <collector> --rule <id>
                                  Create a human-approval card that removes an existing policy rule

Global options:
  --help, -h                     Show this help
`;

export function getHelpText(): string {
  return HELP_TEXT;
}

// ---------------------------------------------------------------------------
// runOpsctl — the thin dispatcher
// ---------------------------------------------------------------------------

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
        return await createCard(parsed.positionals[0], adapter, options);
      case 'auto-execute':
        return await autoExecute(parsed.positionals[0], adapter, options);
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
      case 'mark-reviewed':
        return markReviewedCard(parsed, adapter, options.now ?? (() => new Date()));
      case 'digest':
        return digestCmd(parsed, adapter, options);
      case 'default-resolve':
        return defaultResolveCmd(parsed, adapter, options.now ?? (() => new Date()));
      case 'metrics':
        return metricsCmd(parsed, adapter, options.now ?? (() => new Date()));
      case 'regret':
        return regretCmd(parsed, adapter, options.now ?? (() => new Date()));
      case 'undo':
        return await undoCard(parsed, adapter, options);
      case 'policy':
        return await policyCommand(parsed, adapter, options, options.now ?? (() => new Date()));
      case 'doctor':
        return doctor(config, adapter, { cwd: options.cwd ?? process.cwd(), env: options.env ?? process.env });
      default:
        return fail(`Unknown opsctl command: ${parsed.command}\n\n${HELP_TEXT}`, 2);
    }
  } catch (error) {
    return fail(`FAIL ${error instanceof Error ? error.message : String(error)}`);
  }
}

// ---------------------------------------------------------------------------
// parseArgs
// ---------------------------------------------------------------------------

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

function isBooleanFlag(name: string): boolean {
  return name === 'json' || name === 'dispatch' || name === 'preview';
}
