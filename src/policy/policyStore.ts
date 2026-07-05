// Policy file IO (PRD §7.7). One policy document per collector, stored in the
// collector's Hermes-space skill directory as `references/policy.json` (machine-read).
// Keryx never edits this file from a worker run; it is written only through the
// human-approved suggestion-card path. This module resolves the path, loads + validates
// the document, and returns a schema-valid empty default when the file is absent so
// the disposition function can treat "no policy" as "review-only" without special-casing.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { type Policy, validatePolicy } from '../schemas/policy';
import type { ValidationError } from '../schemas/validate';

export interface PolicyStoreOptions {
  // Absolute path to the Hermes home (defaults to $HERMES_HOME, then ~/.hermes).
  hermesHome?: string;
  env?: Record<string, string | undefined>;
  now?: () => Date;
}

export type LoadPolicyResult =
  | { ok: true; exists: boolean; policy: Policy; path: string }
  | { ok: false; exists: boolean; errors: ValidationError[]; path: string };

export type WritePolicyResult =
  | { ok: true; policy: Policy; path: string }
  | { ok: false; errors: ValidationError[]; path: string };

// A collector id may arrive either as the canonical `keryx-<source>` or as a bare
// `<source>`. Normalise to the source so directory math is uniform.
function sourceOf(collector: string): string {
  return collector.startsWith('keryx-') ? collector.slice('keryx-'.length) : collector;
}

// Canonical `keryx-<source>` collector id.
function collectorId(collector: string): string {
  return `keryx-${sourceOf(collector)}`;
}

// The Hermes-space skill directory name for a collector's policy + notes.
export function collectorSkillDir(collector: string): string {
  return `keryx-collector-${sourceOf(collector)}`;
}

function resolveHermesHome(options: PolicyStoreOptions): string {
  const env = options.env ?? process.env;
  return options.hermesHome ?? env.HERMES_HOME ?? join(env.HOME ?? homedir(), '.hermes');
}

// Absolute path to a collector's machine-read policy document.
export function resolvePolicyPath(collector: string, options: PolicyStoreOptions = {}): string {
  return join(resolveHermesHome(options), 'skills', collectorSkillDir(collector), 'references', 'policy.json');
}

// A schema-valid empty policy: no rules (everything resolves to review) and the
// spend-always-approval threshold on. Used as the default when no file exists.
export function emptyPolicy(collector: string, now: () => Date = () => new Date()): Policy {
  return {
    schema: 'keryx.policy.v1',
    collector: collectorId(collector),
    version: 1,
    updated_at: now().toISOString(),
    rules: [],
    thresholds: { spend_requires_approval_always: true },
    track_record: {},
  };
}

export function loadPolicy(collector: string, options: PolicyStoreOptions = {}): LoadPolicyResult {
  const path = resolvePolicyPath(collector, options);
  const now = options.now ?? (() => new Date());

  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { ok: true, exists: false, policy: emptyPolicy(collector, now), path };
    }
    return {
      ok: false,
      exists: true,
      path,
      errors: [
        {
          path: '',
          message: `could not read policy file: ${error instanceof Error ? error.message : String(error)}`,
          keyword: 'read',
          params: {},
        },
      ],
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    return {
      ok: false,
      exists: true,
      path,
      errors: [
        {
          path: '',
          message: `policy file is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
          keyword: 'parse',
          params: {},
        },
      ],
    };
  }

  const validation = validatePolicy(parsed);
  if (!validation.ok) {
    return { ok: false, exists: true, errors: validation.errors, path };
  }

  return { ok: true, exists: true, policy: validation.value, path };
}

export function writePolicy(policy: Policy, options: PolicyStoreOptions = {}): WritePolicyResult {
  const path = resolvePolicyPath(policy.collector, options);
  const validation = validatePolicy(policy);
  if (!validation.ok) {
    return { ok: false, errors: validation.errors, path };
  }

  const tempPath = `${path}.tmp-${process.pid}-${Date.now()}`;
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(tempPath, `${JSON.stringify(validation.value, null, 2)}\n`, 'utf8');
    renameSync(tempPath, path);
  } catch (error) {
    return {
      ok: false,
      path,
      errors: [
        {
          path: '',
          message: `could not write policy file: ${error instanceof Error ? error.message : String(error)}`,
          keyword: 'write',
          params: {},
        },
      ],
    };
  }

  return { ok: true, policy: validation.value, path };
}
