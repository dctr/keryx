// validate-* command handlers: pure schema-validation commands. Each validates
// a JSON file against a named schema and emits an OK/FAIL line.

import type { CommandResult } from '../output';
import { fail, formatValidationErrors, ok } from '../output';
import { parseJsonFile } from '../shared';
import { validateActionItem } from '../../schemas/actionItem';
import { validateCollectorState } from '../../schemas/collectorState';
import { validateCorrection } from '../../schemas/correction';
import { validateDismissalDecision } from '../../schemas/dismissalDecision';
import { validateExecutionDecision } from '../../schemas/executionDecision';
import { validateOutcome } from '../../schemas/outcome';
import { validatePolicy } from '../../schemas/policy';
import { validatePolicyDecision } from '../../schemas/policyDecision';

import type { ValidationResult } from '../../schemas/validate';

type ValidateFn<T> = (raw: unknown) => ValidationResult<T>;

interface ValidateSpec<T> {
  cmd: string;
  noun: string;
  validate: ValidateFn<T>;
  echoField: (v: T) => string;
}

function runValidate<T>(filePath: string | undefined, spec: ValidateSpec<T>): CommandResult {
  if (!filePath) {
    return fail(`FAIL ${spec.cmd} requires a JSON file path`, 2);
  }
  const validation = spec.validate(parseJsonFile(filePath));
  if (!validation.ok) {
    return fail(`FAIL invalid ${spec.noun}: ${filePath}\n${formatValidationErrors(validation.errors)}`);
  }
  return ok(`OK valid ${spec.noun}: ${spec.echoField(validation.value)}`);
}

export function validateCard(filePath: string | undefined): CommandResult {
  return runValidate(filePath, {
    cmd: 'validate-card',
    noun: 'action card',
    validate: validateActionItem,
    echoField: (v) => v.title,
  });
}

export function validateDecision(filePath: string | undefined): CommandResult {
  return runValidate(filePath, {
    cmd: 'validate-decision',
    noun: 'execution decision',
    validate: validateExecutionDecision,
    echoField: (v) => v.selected_option_id,
  });
}

export function validateState(filePath: string | undefined): CommandResult {
  return runValidate(filePath, {
    cmd: 'validate-state',
    noun: 'collector state',
    validate: validateCollectorState,
    echoField: (v) => v.source,
  });
}

export function validatePolicyDecisionCommand(filePath: string | undefined): CommandResult {
  return runValidate(filePath, {
    cmd: 'validate-policy-decision',
    noun: 'policy decision',
    validate: validatePolicyDecision,
    echoField: (v) => v.disposition,
  });
}

export function validateOutcomeCommand(filePath: string | undefined): CommandResult {
  return runValidate(filePath, {
    cmd: 'validate-outcome',
    noun: 'outcome',
    validate: validateOutcome,
    echoField: (v) => v.executed_option_id,
  });
}

export function validatePolicyCommand(filePath: string | undefined): CommandResult {
  return runValidate(filePath, {
    cmd: 'validate-policy',
    noun: 'policy',
    validate: validatePolicy,
    echoField: (v) => v.collector,
  });
}

export function validateDismissalCommand(filePath: string | undefined): CommandResult {
  return runValidate(filePath, {
    cmd: 'validate-dismissal',
    noun: 'dismissal decision',
    validate: validateDismissalDecision,
    echoField: (v) => v.dismissed_external_id,
  });
}

export function validateCorrectionCommand(filePath: string | undefined): CommandResult {
  return runValidate(filePath, {
    cmd: 'validate-correction',
    noun: 'correction',
    validate: validateCorrection,
    echoField: (v) => v.kind,
  });
}
