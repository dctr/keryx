# Keryx v005 Implementation Plan: Attention-Allocation Surface

> **For Hermes:** Use the subagent-driven-development skill to implement this plan task-by-task. Dispatch a fresh subagent per task with full context; run spec-compliance review then code-quality review before proceeding.

**Goal:** Evolve Keryx from a single-queue approval inbox into a layered attention-allocation surface — three dispositions (silent / review / interrupt), confidence-graduated autonomy, a read-only digest of autonomous outcomes, honest undo, gateway interrupts via `hermes send`, a schema-bounded policy store, and attention metrics — per `docs/archive/v005/PRD.md`.

**Architecture:** Keryx stays a thin control surface over Hermes Kanban (single source of truth; allowlisted adapter; untrusted source content; no second DB). A card's *disposition* is derived by a deterministic policy function from two bounded risk axes (`reversibility`, `blast_radius`) plus a `confidence` band derived from the user's own approval history for an open `class` key. Silent execution writes a synthetic policy-decision comment and a structured outcome; a digest job reports outcomes by relevancy; interrupts push through `hermes send`.

**Tech Stack:** Node 22+, TypeScript ESM, Ajv (draft-07), Fastify, Svelte 5, Vitest, Playwright. Python plugin adapter (thin). POSIX `sh` setup script.

**Scope constraints (from the requester — read before starting):**
- **Only edit files under `~/Projects/keryx/`.** The single exception is the one-time teardown in Phase 0 (delete an installed skill folder and clear the board), which touches `~/.hermes/...` and the live board on explicit instruction.
- **Fresh-install only. No backwards compatibility, no migration shim, no v1 tolerance.** Delete the old `keryx.action_item.v1` schema outright; the new card contract is `keryx.action_item.v2`. Existing board cards are deleted in Phase 0, so nothing needs to read v1.
- **Delete the sample collectors folder** `~/Projects/keryx/collectors/` entirely.
- **Update the whole project**, not just `src/`: bundled skills (`skills/keryx/`), `docs/`, `AGENTS.md`, `README.md`, schemas, setup script, tests.

**Phase map (mirrors PRD §13 build-ordering):**
- Phase 0 — Teardown & pre-flight (delete board cards, installed collectors skill folder, repo `collectors/`).
- Phase 1 — Contracts: `action_item.v2` + all new comment/policy/outcome schemas + validators (behaviour-neutral; everything still resolves to review).
- Phase 2 — Disposition function + confidence aggregator (judgment layer).
- Phase 3 — `read_only` silent path + outcomes + review log + `keryx-digest`.
- Phase 4 — Policy store + shadow mode + promotion/demotion + metrics.
- Phase 5 — State-changing silent path + undo.
- Phase 6 — `hermes send` adapter shape + interrupt ladder + expiring defaults + setup `notify_target`.
- Phase 7 — Skills, docs, AGENTS.md, README, and the doc/skill assertion tests.

Each task is 2–5 minutes, TDD where it produces code, and ends with a conventional commit. Run `npm run lint` and `npm test` before every commit; add `npm run typecheck` for UI/shared-type changes, `npm run build` for server-entry changes, `npm run e2e` for inbox behaviour.

---

## Phase 0 — Teardown & pre-flight

### Task 0.1: Confirm a clean working tree and branch

**Objective:** Start from a known state.

**Step 1:** Run `cd ~/Projects/keryx && git status --short`. Expected: clean (only `docs/archive/v005/` additions if not yet committed).

**Step 2:** Create a working branch.
```bash
git checkout -b feat/v005-attention-surface
```

**Step 3:** Commit (no-op marker if nothing staged — skip if clean).

---

### Task 0.2: Delete all tasks from the live `keryx` Kanban board (one-time, outside repo)

**Objective:** Clear the board so no `action_item.v1` card survives into the v2 world. Explicitly authorized; this is a live mutation.

**Step 1:** List current cards across every status.
```bash
hermes kanban --board keryx list --json > /tmp/keryx-board-dump.json
cat /tmp/keryx-board-dump.json
```

**Step 2:** Archive (or delete, if the installed Hermes supports `kanban delete`) every returned task id. Prefer delete; fall back to archive.
```bash
# inspect available verbs first
hermes kanban --help | sed -n '1,60p'
# then, per id from the dump:
#   hermes kanban --board keryx delete <id>     # if supported
#   hermes kanban --board keryx archive <id>    # fallback
```

**Step 3:** Verify the board is empty.
```bash
hermes kanban --board keryx list --json
```
Expected: `[]` (or only archived rows if delete is unavailable).

**Step 4:** Remove the temp dump: `rm -f /tmp/keryx-board-dump.json`. No commit (no repo change).

---

### Task 0.3: Delete the installed collectors skill folder (one-time, outside repo)

**Objective:** Remove the installed collector skills the requester does not want upgraded.

**Step 1:** Confirm the path exists.
```bash
ls -la ~/.hermes/skills/keryx-collectors 2>/dev/null || echo "absent"
```

**Step 2:** Delete it.
```bash
rm -rf ~/.hermes/skills/keryx-collectors
```

**Step 3:** Verify removal: `ls ~/.hermes/skills | grep keryx || echo "no keryx skills remain"`. No commit (outside repo).

---

### Task 0.4: Delete the repository sample collectors folder

**Objective:** Remove `collectors/` from the project; v005 ships no sample collectors.

**Files:**
- Delete: `collectors/` (entire directory: `README.md`, `bash-first-template/`, `direct-agent-template/`).

**Step 1:**
```bash
git rm -r collectors/
```

**Step 2:** Verify: `git status --short` shows the deletions; `ls collectors 2>/dev/null || echo gone`.

**Step 3:** Do **not** run the full test suite yet — `tests/unit/templates-and-docs.test.ts` references `collectors/` and will fail. Phase 7 rewrites it. Commit now with a note.
```bash
git add -A
git commit -m "chore: remove sample collectors folder (v005 ships none)"
```

---

## Phase 1 — Contracts (schemas + validators), behaviour-neutral

> All new cards are `keryx.action_item.v2`. Disposition is not yet computed; `create-card` still produces `blocked` (Phase 3+ wires silent). This phase only lands the contracts and validators.

### Task 1.1: Write the `action-item.v2` JSON schema

**Objective:** Replace the v1 card contract with the two-axis risk model.

**Files:**
- Create: `schemas/action-item.v2.schema.json`
- Delete (Task 1.9): `schemas/action-item.v1.schema.json`

**Step 1:** Write the schema.
```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "$id": "https://keryx.local/schemas/action-item.v2.schema.json",
  "title": "Keryx action item v2",
  "type": "object",
  "additionalProperties": false,
  "required": [
    "schema",
    "source",
    "collector",
    "class",
    "external_id",
    "idempotency_key",
    "origin_descriptor",
    "title",
    "summary",
    "urgency",
    "source_refs",
    "options",
    "created_at"
  ],
  "properties": {
    "schema": { "const": "keryx.action_item.v2" },
    "source": { "type": "string", "minLength": 1 },
    "collector": { "type": "string", "pattern": "^keryx-[A-Za-z0-9_.:-]+$" },
    "class": { "type": "string", "minLength": 1, "pattern": "^[A-Za-z0-9_.:-]+$" },
    "external_id": { "type": "string", "minLength": 1 },
    "idempotency_key": { "type": "string", "pattern": "^keryx:[^:]+:.+$" },
    "origin_descriptor": { "type": "string", "minLength": 1 },
    "title": { "type": "string", "minLength": 1 },
    "summary": { "type": "string", "minLength": 1 },
    "effort": { "enum": ["minimal", "research", "complex"] },
    "urgency": { "enum": ["low", "normal", "soon", "urgent"] },
    "proposed_disposition": { "enum": ["silent", "review", "interrupt"] },
    "result_delivery": { "enum": ["digest", "push", "log_only"] },
    "digest_cadence": { "enum": ["daily", "weekly"] },
    "digest_category": { "type": "string", "minLength": 1 },
    "deadline": {
      "anyOf": [
        { "type": "string", "pattern": "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d+)?(?:Z|[+-]\\d{2}:\\d{2})$" },
        { "type": "null" }
      ]
    },
    "risk": { "anyOf": [{ "type": "string" }, { "type": "null" }] },
    "default_on_timeout": {
      "anyOf": [
        {
          "type": "object",
          "additionalProperties": false,
          "required": ["action", "after"],
          "properties": {
            "action": { "enum": ["execute_option", "dismiss"] },
            "option_id": { "type": "string", "minLength": 1 },
            "after": { "type": "string", "minLength": 1 }
          }
        },
        { "type": "null" }
      ]
    },
    "source_refs": {
      "type": "array",
      "minItems": 1,
      "items": {
        "type": "object",
        "required": ["type"],
        "properties": { "type": { "type": "string", "minLength": 1 } },
        "additionalProperties": {
          "anyOf": [{ "type": "string" }, { "type": "number" }, { "type": "boolean" }, { "type": "null" }]
        }
      }
    },
    "options": { "type": "array", "minItems": 1, "items": { "$ref": "#/definitions/option" } },
    "ui": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "primary_option_id": { "type": "string", "minLength": 1 },
        "display_group": { "type": "string", "minLength": 1 }
      }
    },
    "created_at": { "type": "string", "pattern": "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d+)?(?:Z|[+-]\\d{2}:\\d{2})$" }
  },
  "definitions": {
    "option": {
      "type": "object",
      "additionalProperties": false,
      "required": ["id", "label", "requires_input", "reversibility", "blast_radius", "execution_prompt"],
      "properties": {
        "id": { "type": "string", "minLength": 1 },
        "label": { "type": "string", "minLength": 1 },
        "requires_input": { "type": "boolean" },
        "input_hint": { "anyOf": [{ "type": "string" }, { "type": "null" }] },
        "delivery": { "anyOf": [{ "type": "string", "minLength": 1 }, { "type": "null" }] },
        "reversibility": { "enum": ["read_only", "reversible", "compensable", "irreversible"] },
        "blast_radius": { "enum": ["self", "external"] },
        "undo_prompt": { "anyOf": [{ "type": "string", "minLength": 1 }, { "type": "null" }] },
        "absolute_floor": {
          "type": "array",
          "items": { "enum": ["money", "destructive", "credential_gate"] },
          "uniqueItems": true
        },
        "execution_prompt": { "type": "string", "minLength": 1 }
      }
    }
  }
}
```

**Step 2:** Commit at the end of Task 1.2 (schema + validator together).

---

### Task 1.2: Write the `action_item.v2` TypeScript validator with cross-checks

**Objective:** Typed validator + the cross-field rules draft-07 cannot express (PRD §7.1).

**Files:**
- Modify: `src/schemas/actionItem.ts` (full rewrite)
- Test: `tests/unit/schema-validation.test.ts` (extend), new `tests/unit/action-item-v2.test.ts`

**Step 1: Write failing test** — `tests/unit/action-item-v2.test.ts`
```ts
import { describe, expect, it } from 'vitest';
import { validateActionItem } from '../../src/schemas/actionItem';

const base = {
  schema: 'keryx.action_item.v2',
  source: 'email',
  collector: 'keryx-email',
  class: 'email:newsletter-unsubscribe',
  external_id: 'inbox:42',
  idempotency_key: 'keryx:email:inbox:42',
  origin_descriptor: 'Inbox — item 42',
  title: 'Handle item 42',
  summary: 'Compact facts only.',
  urgency: 'normal',
  source_refs: [{ type: 'email', uid: '42' }],
  options: [
    { id: 'o1', label: 'Do it', requires_input: false, input_hint: null, delivery: null,
      reversibility: 'reversible', blast_radius: 'self', undo_prompt: 'Undo it.',
      execution_prompt: 'Do the thing.' },
  ],
  created_at: '2026-06-25T00:00:00+10:00',
};

describe('action_item.v2 validation', () => {
  it('accepts a valid reversible+self card', () => {
    expect(validateActionItem(base).ok).toBe(true);
  });

  it('rejects read_only with blast_radius=external', () => {
    const card = { ...base, options: [{ ...base.options[0], reversibility: 'read_only', blast_radius: 'external', undo_prompt: null }] };
    const r = validateActionItem(card);
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r).includes('read_only')).toBe(true);
  });

  it('rejects read_only carrying an absolute_floor value', () => {
    const card = { ...base, options: [{ ...base.options[0], reversibility: 'read_only', blast_radius: 'self', undo_prompt: null, absolute_floor: ['money'] }] };
    expect(validateActionItem(card).ok).toBe(false);
  });

  it('requires undo_prompt for reversible/compensable and forbids it for read_only/irreversible', () => {
    const reversibleNoUndo = { ...base, options: [{ ...base.options[0], undo_prompt: null }] };
    expect(validateActionItem(reversibleNoUndo).ok).toBe(false);
    const readOnly = { ...base, options: [{ ...base.options[0], reversibility: 'read_only', undo_prompt: null }] };
    expect(validateActionItem(readOnly).ok).toBe(true);
  });

  it('requires default_on_timeout with a real option_id when proposed_disposition=interrupt', () => {
    const noTimeout = { ...base, proposed_disposition: 'interrupt' };
    expect(validateActionItem(noTimeout).ok).toBe(false);
    const badRef = { ...base, proposed_disposition: 'interrupt', default_on_timeout: { action: 'execute_option', option_id: 'missing', after: 'PT2H' } };
    expect(validateActionItem(badRef).ok).toBe(false);
    const good = { ...base, proposed_disposition: 'interrupt', default_on_timeout: { action: 'execute_option', option_id: 'o1', after: 'PT2H' } };
    expect(validateActionItem(good).ok).toBe(true);
  });
});
```

**Step 2: Run** `npx vitest run tests/unit/action-item-v2.test.ts` — expect FAIL (validator still v1).

**Step 3: Rewrite** `src/schemas/actionItem.ts`
```ts
import actionItemSchema from '../../schemas/action-item.v2.schema.json';

import { type ValidationError, createValidator } from './validate';

export type Reversibility = 'read_only' | 'reversible' | 'compensable' | 'irreversible';
export type BlastRadius = 'self' | 'external';
export type Urgency = 'low' | 'normal' | 'soon' | 'urgent';
export type Effort = 'minimal' | 'research' | 'complex';
export type Disposition = 'silent' | 'review' | 'interrupt';
export type ResultDelivery = 'digest' | 'push' | 'log_only';
export type AbsoluteFloor = 'money' | 'destructive' | 'credential_gate';

export interface SourceRef { type: string; [k: string]: string | number | boolean | null; }

export interface ActionOption {
  id: string;
  label: string;
  requires_input: boolean;
  input_hint?: string | null;
  delivery?: string | null;
  reversibility: Reversibility;
  blast_radius: BlastRadius;
  undo_prompt?: string | null;
  absolute_floor?: AbsoluteFloor[];
  execution_prompt: string;
}

export interface DefaultOnTimeout { action: 'execute_option' | 'dismiss'; option_id?: string; after: string; }

export interface ActionItemUiHints { primary_option_id?: string; display_group?: string; }

export interface ActionItem {
  schema: 'keryx.action_item.v2';
  source: string;
  collector: string;
  class: string;
  external_id: string;
  idempotency_key: string;
  origin_descriptor: string;
  title: string;
  summary: string;
  effort?: Effort;
  urgency: Urgency;
  proposed_disposition?: Disposition;
  result_delivery?: ResultDelivery;
  digest_cadence?: 'daily' | 'weekly';
  digest_category?: string;
  deadline?: string | null;
  risk?: string | null;
  default_on_timeout?: DefaultOnTimeout | null;
  source_refs: SourceRef[];
  options: ActionOption[];
  ui?: ActionItemUiHints;
  created_at: string;
}

export { actionItemSchema };

function optionsOf(value: unknown): Array<Record<string, unknown>> {
  const opts = (value as { options?: unknown }).options;
  return Array.isArray(opts) ? opts.filter((o): o is Record<string, unknown> => typeof o === 'object' && o !== null) : [];
}

function crossValidatePrimaryOptionId(value: unknown): ValidationError[] {
  if (typeof value !== 'object' || value === null) return [];
  const ui = (value as { ui?: { primary_option_id?: unknown } }).ui;
  const primary = ui?.primary_option_id;
  if (typeof primary !== 'string') return [];
  const ids = optionsOf(value).map((o) => o.id).filter((id): id is string => typeof id === 'string');
  return ids.includes(primary) ? [] : [{ path: '/ui/primary_option_id', message: 'must reference one of the defined option ids', keyword: 'cross-validation', params: {} }];
}

function crossValidateReadOnly(value: unknown): ValidationError[] {
  if (typeof value !== 'object' || value === null) return [];
  const errors: ValidationError[] = [];
  optionsOf(value).forEach((o, i) => {
    if (o.reversibility !== 'read_only') return;
    if (o.blast_radius !== 'self') {
      errors.push({ path: `/options/${i}/blast_radius`, message: 'read_only requires blast_radius=self', keyword: 'cross-validation', params: {} });
    }
    if (Array.isArray(o.absolute_floor) && o.absolute_floor.length > 0) {
      errors.push({ path: `/options/${i}/absolute_floor`, message: 'read_only must not carry an absolute_floor value', keyword: 'cross-validation', params: {} });
    }
  });
  return errors;
}

function crossValidateUndoPrompt(value: unknown): ValidationError[] {
  if (typeof value !== 'object' || value === null) return [];
  const errors: ValidationError[] = [];
  optionsOf(value).forEach((o, i) => {
    const rev = o.reversibility;
    const hasUndo = typeof o.undo_prompt === 'string' && o.undo_prompt.length > 0;
    if ((rev === 'reversible' || rev === 'compensable') && !hasUndo) {
      errors.push({ path: `/options/${i}/undo_prompt`, message: 'undo_prompt required for reversible/compensable options', keyword: 'cross-validation', params: {} });
    }
    if ((rev === 'read_only' || rev === 'irreversible') && hasUndo) {
      errors.push({ path: `/options/${i}/undo_prompt`, message: 'undo_prompt must be absent for read_only/irreversible options', keyword: 'cross-validation', params: {} });
    }
  });
  return errors;
}

function crossValidateInterruptTimeout(value: unknown): ValidationError[] {
  if (typeof value !== 'object' || value === null) return [];
  if ((value as { proposed_disposition?: unknown }).proposed_disposition !== 'interrupt') return [];
  const dot = (value as { default_on_timeout?: unknown }).default_on_timeout;
  if (typeof dot !== 'object' || dot === null) {
    return [{ path: '/default_on_timeout', message: 'required when proposed_disposition=interrupt', keyword: 'cross-validation', params: {} }];
  }
  const action = (dot as { action?: unknown }).action;
  const optionId = (dot as { option_id?: unknown }).option_id;
  if (action === 'execute_option') {
    const ids = optionsOf(value).map((o) => o.id);
    if (typeof optionId !== 'string' || !ids.includes(optionId)) {
      return [{ path: '/default_on_timeout/option_id', message: 'must reference a defined option id', keyword: 'cross-validation', params: {} }];
    }
  }
  return [];
}

export const validateActionItem = createValidator<ActionItem>(actionItemSchema, [
  crossValidatePrimaryOptionId,
  crossValidateReadOnly,
  crossValidateUndoPrompt,
  crossValidateInterruptTimeout,
]);
```

**Step 4: Run** `npx vitest run tests/unit/action-item-v2.test.ts` — expect PASS.

**Step 5: Commit**
```bash
git add schemas/action-item.v2.schema.json src/schemas/actionItem.ts tests/unit/action-item-v2.test.ts
git commit -m "feat: add keryx.action_item.v2 risk-axis card schema and validator"
```

---

### Task 1.3: Add the `dismissal-decision.v1` schema + validator

**Objective:** Formalize the dismissal body `commands.ts` already emits (PRD §7.10 / §8.2).

**Files:**
- Create: `schemas/dismissal-decision.v1.schema.json`
- Create: `src/schemas/dismissalDecision.ts`
- Test: `tests/unit/schema-validation.test.ts` (extend)

**Step 1: Schema** — fields the current `buildDismissalDecision` emits: `schema` const `keryx.dismissal_decision.v1`, `dismissal_scope` const `exact_item`, `reason` (string|null), `dismissed_external_id`, `dismissed_idempotency_key`, `dismissed_by`, `dismissed_via`, `dismissed_at` (ISO). `additionalProperties: false`.

**Step 2: Validator** — mirror `src/schemas/executionDecision.ts` pattern:
```ts
import dismissalDecisionSchema from '../../schemas/dismissal-decision.v1.schema.json';
import { createValidator } from './validate';
export interface DismissalDecision {
  schema: 'keryx.dismissal_decision.v1';
  dismissal_scope: 'exact_item';
  reason: string | null;
  dismissed_external_id: string;
  dismissed_idempotency_key: string;
  dismissed_by: string;
  dismissed_via: string;
  dismissed_at: string;
}
export { dismissalDecisionSchema };
export const validateDismissalDecision = createValidator<DismissalDecision>(dismissalDecisionSchema);
```

**Step 3: Test** — add a `describe('dismissal-decision.v1')` block asserting a known-good body validates and a missing-field body fails.

**Step 4: Run + commit**
```bash
git add schemas/dismissal-decision.v1.schema.json src/schemas/dismissalDecision.ts tests/unit/schema-validation.test.ts
git commit -m "feat: add keryx.dismissal_decision.v1 schema and validator"
```

---

### Task 1.4: Add the `policy-decision.v1` schema + validator

**Objective:** The synthetic trusted decision a silent execution writes (PRD §7.4 / §8.3).

**Files:**
- Create: `schemas/policy-decision.v1.schema.json`
- Create: `src/schemas/policyDecision.ts`
- Test: `tests/unit/schema-validation.test.ts`

**Schema fields:** `schema` const `keryx.policy_decision.v1`; `selected_option_id` (string); `disposition` enum `silent|review|interrupt`; `rule_id` (string|null — null/`"read-only"` for read_only); `reasons` (array of string, minItems 1); `approved_by` enum `["keryx-policy"]` (non-human only); `approved_via` (string, e.g. `policy:<rule-id>` or `policy:read-only`); `approved_at` (ISO). `additionalProperties: false`.

**Validator:** mirror the executionDecision pattern with a `PolicyDecision` interface.

**Commit:** `feat: add keryx.policy_decision.v1 schema and validator`.

---

### Task 1.5: Add the `outcome.v1` schema + validator

**Objective:** Structured silent-execution outcome the digest reads (PRD §7.4 / §8.4).

**Files:**
- Create: `schemas/outcome.v1.schema.json`
- Create: `src/schemas/outcome.ts`
- Test: `tests/unit/schema-validation.test.ts`

**Schema fields:** `schema` const `keryx.outcome.v1`; `executed_option_id` (string); `result_summary` (string, compact — no raw bodies); `result_delivery` enum `digest|push|log_only`; `digest_category` (string|null); `digest_cadence` enum `daily|weekly` (optional); `changed_state` (string|null, compact note); `delivered_via` (string|null); `digested` (boolean, default false — set true once reported); `completed_at` (ISO). `additionalProperties: false`.

**Commit:** `feat: add keryx.outcome.v1 schema and validator`.

---

### Task 1.6: Add the `policy.v1` schema + validator

**Objective:** Per-collector policy store with uniform rules + derived track record (PRD §7.7 / §8.5).

**Files:**
- Create: `schemas/policy.v1.schema.json`
- Create: `src/schemas/policy.ts`
- Test: `tests/unit/policy-schema.test.ts`

**Schema fields:**
- `schema` const `keryx.policy.v1`; `collector` pattern `^keryx-...`; `version` (integer); `updated_at` (ISO).
- `rules`: array of `{ id, class, gate: { max_blast_radius: self|external, min_reversibility: read_only|reversible|compensable|irreversible, min_confidence: cold|warming|trusted }, disposition: silent|review|interrupt, result_delivery: digest|push|log_only (optional), state: shadow|active, approved_by, approved_at, source_card_id (string|null), scope_note (string|null) }`.
- `thresholds`: object (additionalProperties false) with at least `spend_requires_approval_always` (boolean, default true).
- `track_record`: object keyed by class → `{ approved, overridden, dismissed, regret (integers), band: cold|warming|trusted, updated_at }`.
- `additionalProperties: false` throughout.

**Validator:** `Policy` interface + `validatePolicy`.

**Commit:** `feat: add keryx.policy.v1 schema and validator`.

---

### Task 1.7: Add `notification.v1` and `regret.v1` schemas + validators

**Objective:** Interrupt/digest dedupe-audit and escalation-regret signal (PRD §8.6).

**Files:**
- Create: `schemas/notification.v1.schema.json`, `schemas/regret.v1.schema.json`
- Create: `src/schemas/notification.ts`, `src/schemas/regret.ts`
- Test: `tests/unit/schema-validation.test.ts`

**notification.v1 fields:** `schema` const `keryx.notification.v1`; `channel` enum `interrupt|digest`; `target` (string); `sent_at` (ISO); `dedupe_key` (string). `additionalProperties: false`.

**regret.v1 fields:** `schema` const `keryx.regret.v1`; `kind` enum `should_have_acted|should_have_asked`; `note` (string|null); `recorded_by` (string); `recorded_at` (ISO). `additionalProperties: false`.

**Commit:** `feat: add keryx.notification.v1 and keryx.regret.v1 schemas`.

---

### Task 1.8: Extend `collector-state.v1` with `executed_external_ids`

**Objective:** Let silent execution participate in cursor-safety ("handled = executed", PRD §8.7).

**Files:**
- Modify: `schemas/collector-state.v1.schema.json` (add optional `executed_external_ids`: array of unique non-empty strings, like `exact_dismissed_external_ids`)
- Modify: `src/schemas/collectorState.ts` (add the optional field to the interface)
- Test: `tests/unit/schema-validation.test.ts` (assert a state with `executed_external_ids` validates; field stays optional)

**Commit:** `feat: add executed_external_ids to keryx.collector_state.v1`.

---

### Task 1.9: Delete the v1 action-item schema and update schema command wiring

**Objective:** Remove the obsolete contract and register the new schemas in the `schema` command (no v1 left).

**Files:**
- Delete: `schemas/action-item.v1.schema.json`
- Modify: `src/opsctl/commands.ts` — `SCHEMA_COMMANDS` map: replace `action-item` fileUrl with `../../schemas/action-item.v2.schema.json`; add `dismissal-decision`, `policy-decision`, `outcome`, `policy`, `notification`, `regret` entries (each importing its schema + file URL).
- Modify: `src/opsctl/commands.ts` HELP_TEXT `schema <...>` line to list the new names.
- Test: `tests/unit/schema-validation.test.ts` and any test importing the v1 path.

**Step 1:** `git rm schemas/action-item.v1.schema.json`

**Step 2:** Update `SCHEMA_COMMANDS` and HELP_TEXT; update `templateCard` to emit a valid v2 body (see Task 1.10).

**Step 3:** Run `npm run lint` — fix any remaining v1 import references (search: `search_files pattern="action-item.v1" `).

**Step 4: Commit** `refactor: drop action-item.v1; register v005 schema commands`.

---

### Task 1.10: Update `template-card` to emit a valid v2 body

**Objective:** `hermes keryx template-card` prints a schema-valid v2 starter (PRD §7.1).

**Files:**
- Modify: `src/opsctl/commands.ts` `templateCard()`
- Test: `tests/unit/opsctl-create-card.test.ts` / a `template-card` test asserting the output validates and is v2.

**Step 1:** Build the template object with: `schema: 'keryx.action_item.v2'`, a `class` like `${source}:replace-me`, `urgency: 'normal'`, one option with `reversibility: 'reversible'`, `blast_radius: 'self'`, `undo_prompt`, no `absolute_floor`, plus `proposed_disposition: 'review'`. Validate before printing (existing pattern).

**Step 2:** Update/extend the template test to assert `validateActionItem(JSON.parse(stdout)).ok === true` and `schema === 'keryx.action_item.v2'`.

**Commit:** `feat: emit action_item.v2 template from template-card`.

---

### Task 1.11: Update fixtures and adapter for v2 cards (behaviour-neutral create)

**Objective:** Make existing opsctl/server tests compile and pass against v2 while `create-card` still produces `blocked`.

**Files:**
- Modify: `src/hermes/adapter.ts` — `createTaskFromActionItem` still creates blocked (Phase 3 adds the ready branch). Update `--skill keryx:keryx-worker` allowlist (unchanged). The `--tenant`/`--created-by` use `actionItem.source`/`actionItem.collector` (unchanged).
- Modify: all test fixtures that build an `ActionItem` literal: `tests/unit/opsctl-execute.test.ts`, `tests/unit/opsctl-dismiss.test.ts`, `tests/unit/opsctl-create-card.test.ts`, `tests/unit/task-view.test.ts`, `tests/unit/server-routes.test.ts`, `tests/integration/*` — change `schema` to `keryx.action_item.v2`, drop `autonomy`, add `class`, and per option add `reversibility`/`blast_radius`/`undo_prompt`.
- Test: run the whole suite.

**Step 1:** Search every `keryx.action_item.v1` literal: `search_files pattern="keryx.action_item.v1" path="."`.

**Step 2:** Rewrite each fixture to v2 (helper: a shared `tests/helpers/sampleActionItem.ts` exporting a valid v2 builder — create it and import from tests to stay DRY).

**Step 3:** Run `npx vitest run` — fix until green (Phase 7 still pending for doc tests; expect `templates-and-docs.test.ts` to fail — that is acceptable until Phase 7. Note it in the commit.)

**Commit:** `test: migrate fixtures to action_item.v2 (docs tests pending Phase 7)`.

---

## Phase 2 — Disposition function + confidence aggregator (judgment layer)

### Task 2.1: Create the confidence band model

**Objective:** Pure module that maps track-record counts → band (PRD §7.3).

**Files:**
- Create: `src/policy/confidence.ts`
- Test: `tests/unit/confidence.test.ts`

**Step 1: Write failing test** covering: zero approvals → `cold`; ≥ warming threshold with no recent regret → `warming`; ≥ trusted threshold + override rate under cap + no recent regret → `trusted`; any recent regret forces ≤ `warming`.

**Step 2: Implement**
```ts
export type Band = 'cold' | 'warming' | 'trusted';
export interface TrackRecord { approved: number; overridden: number; dismissed: number; regret: number; }
export interface BandThresholds { warmingApprovals: number; trustedApprovals: number; maxOverrideRate: number; }
export const DEFAULT_BAND_THRESHOLDS: BandThresholds = { warmingApprovals: 3, trustedApprovals: 10, maxOverrideRate: 0.15 };

export function deriveBand(tr: TrackRecord, t: BandThresholds = DEFAULT_BAND_THRESHOLDS): Band {
  if (tr.regret > 0) return tr.approved >= t.warmingApprovals ? 'warming' : 'cold';
  const total = tr.approved + tr.overridden;
  const overrideRate = total === 0 ? 1 : tr.overridden / total;
  if (tr.approved >= t.trustedApprovals && overrideRate <= t.maxOverrideRate) return 'trusted';
  if (tr.approved >= t.warmingApprovals) return 'warming';
  return 'cold';
}
```
> Note: thresholds are config (PRD §16 q2), not schema. They live in `keryx.config.json` later; default constants here.

**Commit:** `feat: add confidence band derivation`.

---

### Task 2.2: Create the disposition function

**Objective:** Deterministic disposition from risk grid + band + urgency + policy (PRD §7.2).

**Files:**
- Create: `src/policy/disposition.ts`
- Test: `tests/unit/disposition.test.ts`

**Step 1: Write the decision table test** — one case per row of PRD §7.2 grid × band × urgency, plus: absolute_floor forces review/interrupt; read_only → silent with no rule; state-changing silent requires an `active` rule whose gate the option satisfies and band meets; shadow rule never silent (computes "would have"); default → review.

**Step 2: Implement** (skeleton — fill from PRD §7.2 ordering)
```ts
import type { ActionItem, ActionOption } from '../schemas/actionItem';
import type { Band } from './confidence';
import type { Policy } from '../schemas/policy';

export type Disposition = 'silent' | 'review' | 'interrupt';
export interface DispositionResult {
  disposition: Disposition;
  tier: 1 | 2 | 3 | 4 | 5 | 6;
  result_delivery: 'digest' | 'push' | 'log_only';
  reasons: string[];
  requires_monitor: boolean;
  rule_id: string | null;
  shadow: boolean; // true when an otherwise-silent rule is still in shadow
}

const REV_RANK = { read_only: 0, reversible: 1, compensable: 2, irreversible: 3 } as const;

export function decideDisposition(
  item: ActionItem,
  selected: ActionOption,
  band: Band,
  policy: Policy | null,
): DispositionResult {
  const reasons: string[] = [];
  const floor = (selected.absolute_floor ?? []).length > 0;

  // 1. Absolute floor
  if (floor) {
    reasons.push(`absolute_floor=${selected.absolute_floor!.join(',')} -> never silent`);
    if (item.urgency === 'urgent' || item.urgency === 'soon') {
      return interrupt(item, reasons);
    }
    return review(reasons);
  }

  // 2. Interrupt
  const interruptRule = matchRule(policy, item.class, selected, 'interrupt');
  if ((item.urgency === 'urgent' || item.urgency === 'soon') && selected.blast_radius === 'external') {
    reasons.push('urgent+external -> interrupt');
    return interrupt(item, reasons, interruptRule?.id ?? null);
  }
  if (interruptRule?.state === 'active') {
    return interrupt(item, reasons, interruptRule.id);
  }

  // 3. Silent (read_only): no rule required
  if (selected.reversibility === 'read_only') {
    reasons.push('read_only -> silent by design');
    return silent(item, reasons, null, false);
  }

  // 4. Silent (state-changing): needs an active rule whose gate is met + band meets requirement
  const rule = matchRule(policy, item.class, selected, 'silent');
  if (rule && bandMeets(band, rule.gate.min_confidence) && gateAllows(rule, selected)) {
    if (rule.state === 'active') {
      reasons.push(`active rule ${rule.id} authorizes silent`);
      return silent(item, reasons, rule.id, false);
    }
    reasons.push(`shadow rule ${rule.id}: would have run silently`);
    return { ...review(reasons), shadow: true, rule_id: rule.id };
  }

  // 5. Default
  reasons.push('no covering rule -> review');
  const result = review(reasons);
  result.requires_monitor = band === 'cold' && (selected.blast_radius === 'external' || REV_RANK[selected.reversibility] >= REV_RANK.compensable);
  return result;
}
// helpers: interrupt(), review(), silent(), matchRule(), bandMeets(), gateAllows() — implement per PRD §7.2.
```

**Step 3: Run** until the decision table passes.

**Commit:** `feat: add deterministic disposition function`.

---

### Task 2.3: Create the track-record aggregator (derive from Kanban)

**Objective:** Rebuild per-class track record from decision/dismissal/regret comments — no second store (PRD §7.7/§7.9, D7).

**Files:**
- Create: `src/policy/trackRecord.ts`
- Test: `tests/unit/track-record.test.ts`

**Step 1: Test** — given an array of `KanbanTask` with comments (execution_decision, dismissal, regret) and their `class`, the aggregator returns per-class `{approved, overridden, dismissed, regret}`. "Override" = an execution_decision whose `selected_option_id` differs from the card's `ui.primary_option_id`.

**Step 2: Implement** a pure function `aggregateTrackRecord(tasks: KanbanTask[]): Record<string, TrackRecord>` that parses each task body (v2) for `class`, scans comments for the three comment schemas, and tallies. Reuse the comment validators from Phase 1.

**Commit:** `feat: derive per-class track record from Kanban audit trail`.

---

## Phase 3 — read_only silent path + outcomes + review log + digest

### Task 3.1: Adapter — add the create-`ready` branch

**Objective:** Let `create-card` produce a `ready` card with a policy-decision comment when disposition resolves to silent (PRD §7.4, §9).

**Files:**
- Modify: `src/hermes/adapter.ts` — add `createReadyTaskFromActionItem(item, policyDecision)` that creates the card, comments the validated `keryx.policy_decision.v1` body, then promotes to `ready` (reusing sticky-block-free path). Keep `createTaskFromActionItem` (blocked) for review disposition.
- Modify: `assertAllowedHermesArgs` allowlist if a new arg ordering is needed (it is not — reuses `create`, `comment`, `promote`).
- Test: `tests/unit/hermes-adapter.test.ts`.

**Step 1: Test** — calling the ready path issues `create` → `comment` (policy_decision JSON) → `promote`, in order; assert the comment body validates as `keryx.policy_decision.v1`.

**Step 2: Implement.** Reuse `extractCreatedTaskId`. The worker (Task 3.4) is what actually executes once dispatched.

**Commit:** `feat: adapter ready-branch for silent card creation`.

---

### Task 3.2: `create-card` computes disposition and routes ready vs blocked

**Objective:** Wire the disposition function into card creation (PRD §7.4). For Phase 3, only `read_only` reaches silent (no policy rules exist yet).

**Files:**
- Modify: `src/opsctl/commands.ts` `createCard()` — after validating the v2 card: pick the option (primary or first); load the collector policy (Task 4.x; in Phase 3 pass `null`); derive band (Phase 3: `cold` via empty track record); call `decideDisposition`; if `silent`, build a `keryx.policy_decision.v1` (rule_id `null`, approved_via `policy:read-only`) and call the ready branch; else create blocked as today.
- Test: `tests/unit/opsctl-create-card.test.ts` — a `read_only`+`self` card creates `ready` with a policy-decision comment; a `reversible` card with no policy creates `blocked`.

**Commit:** `feat: route create-card by disposition (read_only -> silent)`.

---

### Task 3.3: Add `keryx.outcome.v1` emission helper + `auto-execute` command

**Objective:** A command/path to run a silent card and record its outcome (PRD §7.4, §9).

**Files:**
- Modify: `src/opsctl/commands.ts` — add `auto-execute <file>` (used by collectors/tests) that validates the card, derives disposition, and on silent creates the ready card; HELP_TEXT updated.
- Test: `tests/unit/opsctl-auto-execute.test.ts`.

> The actual side-effect execution is done by the Kanban worker (skill), not opsctl. `auto-execute` is the creation+promotion entrypoint; the worker writes the `outcome.v1` comment on completion. Keep opsctl's job to "create the ready card + decision comment."

**Commit:** `feat: add hermes keryx auto-execute`.

---

### Task 3.4: Update the worker skill for the silent + outcome path

**Objective:** Worker trusts a `policy_decision.v1` comment for read_only/active-rule options, re-checks the floor, and writes a `keryx.outcome.v1` comment (PRD §10).

**Files:**
- Modify: `skills/keryx/keryx-worker/SKILL.md`
- Test: `tests/unit/skills.test.ts` (extend; see Phase 7 for the full skill-test rewrite — coordinate).

**Changes (text):** add a section: "Trusted decisions" now include `keryx.policy_decision.v1` (validate via `hermes keryx validate-decision`? — add a `validate-policy-decision` command in Task 3.5, or reuse a generic `validate <schema> <file>`). Worker accepts a policy_decision only if the selected option is `read_only` OR its axes match an `active` rule, re-queries the source, verifies a `read_only` plan mutates nothing/emits no external signal, performs the action, then writes a `keryx.outcome.v1` comment and moves to `done`.

**Commit:** `docs: worker skill silent path + outcome contract`.

---

### Task 3.5: Add `validate-policy-decision`, `validate-outcome`, `validate-policy`, `validate-dismissal` commands

**Objective:** CLI validation surface for every new machine-written body (workers/jobs run outside the TS runtime — PRD §10).

**Files:**
- Modify: `src/opsctl/commands.ts` — add the four commands mirroring `validateDecision`; HELP_TEXT.
- Test: `tests/unit/opsctl-readonly.test.ts` (extend) or a new `tests/unit/opsctl-validate.test.ts`.

**Commit:** `feat: add validate-policy-decision/outcome/policy/dismissal commands`.

---

### Task 3.6: Build the `keryx-digest` job script + `digest --preview` command

**Objective:** Read silent outcomes since last digest, group by relevancy, send via gateway; `--preview` renders without sending (PRD §7.6).

**Files:**
- Create: `src/opsctl/digest.ts` (pure compose logic: input outcomes → grouped message; omit empty categories; empty → `[SILENT]`)
- Modify: `src/opsctl/commands.ts` — add `digest [--preview] [--cadence daily|weekly]`. `--preview` prints; without it, sends via `hermes send` (Phase 6 adds the adapter shape; until then `digest` only supports `--preview` and errors clearly if asked to send).
- Test: `tests/unit/digest.test.ts` — given outcome comments across categories, assert grouped output, omit-empty, `[SILENT]` when none, and once-only (digested flag).

**Step 1: Test the composer** with fixtures modeled on `daily-brief` output (sections like `📰 FACEBOOK`, `🧹 DONE FOR YOU`).

**Step 2: Implement** the composer + command (`--preview` first; send path stubbed to throw "configure notify_target / Phase 6" until Task 6.x).

**Commit:** `feat: add keryx digest composer and --preview`.

---

### Task 3.7: UI — Review log shows outcomes; lanes updated

**Objective:** "Completed" → Review log with outcome + status of how it was decided; remove autonomy filter; surface new evidence (PRD §7.10, §9).

**Files:**
- Modify: `src/web/lib/filters.ts` — view keys become `needsYou` (blocked/todo), `running` (ready/running), `reviewLog` (done), `dismissed` (archived). Remove `autonomyOptions`/`AutonomyFilter`.
- Modify: `src/web/lib/taskView.ts` — drop `autonomy*`; add `reversibility`, `blastRadius`, `confidenceBand?`, `disposition?`, outcome summary; status labels: `done` → "Review log".
- Modify: `src/web/App.svelte` — lane labels, remove autonomy `<select>`, render new badges; add Undo button stub (wired Phase 5).
- Test: `tests/unit/task-view.test.ts`, `tests/unit/filters` (if present), `tests/e2e/inbox.spec.ts`.

**Commit:** `feat: UI review-log lanes and v2 evidence badges`.

---

## Phase 4 — Policy store + shadow mode + metrics

### Task 4.1: Policy file IO + `policy show/validate`

**Objective:** Read/validate a collector's `references/policy.json` (PRD §7.7).

**Files:**
- Create: `src/policy/policyStore.ts` — resolve a collector's policy path under `$HERMES_HOME/skills/keryx-collector-<source>/references/policy.json`; load+validate; return empty default if absent.
- Modify: `src/opsctl/commands.ts` — `policy show <collector>` (prints active+shadow rules and track-record bands), `policy validate <file>`.
- Test: `tests/unit/policy-store.test.ts`.

**Commit:** `feat: add policy store IO and policy show/validate`.

---

### Task 4.2: `policy propose` creates a human-approval suggestion card

**Objective:** No rule activates without a human-approved card (PRD §7.7, §11.1).

**Files:**
- Modify: `src/opsctl/commands.ts` — `policy propose <file>`: validate the proposed rule, then create a blocked `action_item.v2` suggestion card (class `policy:rule-proposal`, option whose `execution_prompt` writes the rule into the collector policy on approval). Reuse `create-card`.
- Test: `tests/unit/opsctl-policy-propose.test.ts`.

**Commit:** `feat: add policy propose (human-approved rule suggestion cards)`.

---

### Task 4.3: Wire policy + band into `create-card`/`auto-execute`

**Objective:** Replace the Phase-3 `null` policy / `cold` band with real lookups (PRD §7.2–7.4).

**Files:**
- Modify: `src/opsctl/commands.ts` — load the collector policy (Task 4.1) and the per-class band (aggregate track record from `adapter.listTasks` history → `deriveBand`); pass both to `decideDisposition`. Shadow rules record "would have" in the policy_decision but still create blocked.
- Test: `tests/unit/opsctl-create-card.test.ts` — active rule → silent ready; shadow rule → blocked with a "would have" reason; band below gate → blocked.

**Commit:** `feat: wire policy and confidence band into disposition`.

---

### Task 4.4: Metrics aggregator + `metrics` command

**Objective:** Attention-economics metrics from Kanban (PRD §7.9, §11; D7).

**Files:**
- Create: `src/policy/metrics.ts` — compute the PRD §7.9 metric set from tasks+comments.
- Modify: `src/opsctl/commands.ts` — `metrics [--window <range>] [--json]`.
- Test: `tests/unit/metrics.test.ts`.

**Commit:** `feat: add keryx metrics aggregator and command`.

---

### Task 4.5: Promotion/demotion proposal logic + worker hook

**Objective:** Propose `shadow→active` (or demote on regret) when bands cross thresholds (PRD §7.3, §13).

**Files:**
- Create: `src/policy/promotion.ts` — given track record + current rules, emit proposal/demotion intents.
- Modify: `skills/keryx/keryx-worker/SKILL.md` — replace the prose `SKILL.md`-edit suggestion loop with structured `keryx.policy.v1` rule proposals and promotion cards.
- Test: `tests/unit/promotion.test.ts`.

**Commit:** `feat: policy promotion/demotion proposals`.

---

### Task 4.6: UI — Policy and Metrics panels

**Objective:** Inspect/revoke rules (shadow vs active, track record) and view metrics (PRD §9).

**Files:**
- Modify: `src/server/routes.ts` — read routes `/api/policy/:collector`, `/api/metrics`; mutating `/api/policy/:collector/revoke` (delegates to opsctl), `/api/tasks/:id/regret`.
- Modify: `src/web/lib/api.ts`, `src/web/App.svelte` — Policy panel, Metrics panel, regret one-click control.
- Test: `tests/unit/server-routes.test.ts`, `tests/integration/server-api.test.ts`, e2e.

**Commit:** `feat: policy and metrics UI + routes`.

---

## Phase 5 — State-changing silent path + undo

### Task 5.1: Worker honors active-rule silent for reversible/compensable

**Objective:** Extend the worker beyond read_only to graduated state-changing classes (PRD §7.4, §11).

**Files:**
- Modify: `skills/keryx/keryx-worker/SKILL.md` — accept policy_decision for non-floor options whose axes match an `active` rule; re-check floor after re-querying source.
- Test: `tests/unit/skills.test.ts`.

**Commit:** `docs: worker silent path for graduated state-changing classes`.

---

### Task 5.2: `undo` command (honest reversibility)

**Objective:** Per-option honest undo/correct (PRD §7.4, D3).

**Files:**
- Modify: `src/opsctl/commands.ts` — `undo <task_id>`: read the executed option's `reversibility`; `reversible` → create a `ready` reversal card running `undo_prompt`, tag original; `compensable` → create a card whose worker sends a *labeled correction*; `irreversible` → no undo, create a corrective/triage card and say so. Undo never bypasses floor gates.
- Modify: `src/server/routes.ts` — `/api/tasks/:id/undo` delegates.
- Test: `tests/unit/opsctl-undo.test.ts` (all three paths), `tests/integration/server-api.test.ts`.

**Commit:** `feat: add honest undo/correct command and route`.

---

### Task 5.3: UI — Undo/Correct + Archive (mark-reviewed) in review log

**Objective:** Review-log actions (PRD §7.10, §9).

**Files:**
- Modify: `src/web/App.svelte`, `src/web/lib/api.ts` — wire Undo/Correct (per reversibility) and Archive (writes `keryx:reviewed` / mark-reviewed route).
- Modify: `src/server/routes.ts` — `/api/tasks/:id/mark-reviewed`.
- Test: e2e `tests/e2e/inbox.spec.ts`, `tests/unit/server-routes.test.ts`.

**Commit:** `feat: review-log undo/archive UI`.

---

## Phase 6 — `hermes send` + interrupt ladder + expiring defaults + setup target

### Task 6.1: Adapter — narrow allowlisted `send <target> <message>` shape

**Objective:** The single new privilege; interrupt/digest delivery only (PRD §7.5, §11.12).

**Files:**
- Modify: `src/hermes/adapter.ts` — add `sendMessage(target, message)` calling `['send', target, message]`; add `isAllowedSendMessageArgs` (exact arity: `args[0]==='send' && args.length===3 && both non-empty`). Keep the existing `send --list` shape. Update `assertAllowedHermesArgs`.
- Test: `tests/unit/hermes-adapter.test.ts` — the 3-arg send is allowed; `send` with other shapes still rejected except `--list`.

**Commit:** `feat: allowlist narrow hermes send <target> <message>`.

---

### Task 6.2: Config — `notify_target`, interrupt budget, quiet hours

**Objective:** Delivery config (PRD §9).

**Files:**
- Modify: `src/config.ts` — add optional `notifyTarget?: string`, `interruptBudget?: { perTierPerDay: Record<string, number> }`, `quietHours?: { start: string; end: string }`, plus band-threshold overrides. Keep them optional with safe defaults (no target = digest-only/no interrupt push).
- Modify: `keryx.config.example.json`.
- Test: `tests/unit/config.test.ts`.

**Commit:** `feat: add notify_target and interrupt/quiet-hours config`.

---

### Task 6.3: Interrupt composer + delivery; wire digest send

**Objective:** Self-contained interrupt message + dedupe; enable digest send (PRD §7.5, §7.6).

**Files:**
- Create: `src/opsctl/interrupt.ts` — compose the PRD §9.2 message (Urgent/Why/Risk/Default/Open in Keryx/Reply); deep link `/#/card/<id>`.
- Modify: `src/opsctl/commands.ts` — when disposition=interrupt and `notify_target` set + within budget/quiet-hours, `adapter.sendMessage` and append `keryx.notification.v1`. Enable `digest` (non-preview) to send via the same path.
- Test: `tests/unit/interrupt.test.ts`, extend `tests/unit/digest.test.ts` for the send path (mock runner).

**Commit:** `feat: interrupt delivery and digest send via hermes send`.

---

### Task 6.4: `keryx-default-resolver` (expiring defaults)

**Objective:** Execute `default_on_timeout` when an interrupt goes unanswered (PRD §7.5, §10.6).

**Files:**
- Create: `src/opsctl/defaultResolver.ts` + a `default-resolve` command (or fold into `digest`): find interrupt cards past `after` with no decision; execute the default option or dismiss; record auto-resolution as an outcome.
- Test: `tests/unit/default-resolver.test.ts`.

**Commit:** `feat: add expiring-default resolver`.

---

### Task 6.5: Setup script — choose and store `notify_target`

**Objective:** Setup lists targets and writes `notify_target` (PRD §9, D2).

**Files:**
- Modify: `keryx-setup.sh` — after delivery-target discovery, add a step: run `hermes send --list --json`, present targets, store the chosen one into `keryx.config.json` (extend the embedded `node` config writer). Dry-run describes it; no real send.
- Test: `tests/integration/setup-script.test.ts` — fake `send --list`; assert `notify_target` written; dry-run prints the intent.

**Commit:** `feat: setup selects and stores notify_target`.

---

## Phase 7 — Skills, docs, AGENTS.md, README, and assertion tests

> These tests currently hard-code the old vocabulary and the deleted `collectors/` paths. They must be rewritten in lockstep with the prose. Do this phase last so the suite goes green.

### Task 7.1: Rewrite `skills/keryx/keryx-collector` and `keryx-collector-creator`

**Objective:** Teach collectors the v2 evidence, `read_only` monitors vs state-changing actions, policy skeleton in `shadow`, digest category/cadence, `notify_target` (PRD §10).

**Files:**
- Modify: `skills/keryx/keryx-collector/SKILL.md`, `skills/keryx/keryx-collector-creator/SKILL.md`, `skills/keryx/DESCRIPTION.md`
- Test: `tests/unit/skills.test.ts` (rewrite assertions — see Task 7.4).

**Key content:** populate per-option `reversibility`/`blast_radius`/`class`; distinguish `read_only` monitor (silent-by-design, digest) from state-changing (graduation ladder); author `references/policy.json` in `shadow`; keep created skills in `$HERMES_HOME/skills/keryx-collector-$NAME/` referenced unqualified; cron attaches created (unqualified) then `keryx:keryx-collector`.

**Commit:** `docs: collector skills for v005 risk model + policy`.

---

### Task 7.2: Rewrite `docs/architecture.md`, `docs/security.md`, `docs/operations.md`, `docs/collector-authoring.md`

**Objective:** Replace v1 lifecycle/autonomy prose with the three-disposition + digest + policy + send model; remove all `collectors/`-folder references (folder deleted).

**Files (modify):** the four docs above.

**Required phrases the rewritten tests will assert (keep these exact, Task 7.4):**
- architecture: `Kanban is the central register`, `blocked`, `ready`, `running`, `done`, `review log`, `silent`, `interrupt`, `disposition`.
- security: `source content is untrusted`, `no raw event persistence`, `trusted execution decision`, `visible browser`, `absolute floor`, `read_only`, `policy is the trust gate`.
- operations: `source status`, `cron jobs`, `Kanban dispatch`, `logs`, `stuck cards`, `$HERMES_HOME/plugins/keryx`, `hermes plugins enable keryx`, `./keryx-setup.sh`, `keryx-digest`.
- collector-authoring: `keryx.action_item.v2`, `untrusted source content`, `idempotency key`, `cursor safety`, `read_only`, `blast_radius`, `keryx:keryx-worker`, the canonical `hermes keryx template-card/schema action-item/validate-card/create-card` loop, and `keryx-collector-<source>` unqualified.

**Step:** Replace the embedded JSON example in `collector-authoring.md` with a valid **v2** body (the doc test parses and validates it against the live schema).

**Commit:** `docs: rewrite architecture/security/operations/collector-authoring for v005`.

---

### Task 7.3: Rewrite `README.md` and `AGENTS.md`

**Objective:** User- and agent-facing surfaces reflect v005; drop the sticky-block warning if the fresh-install board path no longer needs it; remove `collectors/` section.

**Files:**
- Modify: `README.md` — update the schema name to `keryx.action_item.v2`; replace the "Authoring collectors / collectors/" section with "Collectors are authored into Hermes' space via `/keryx-collector-creator`"; document `notify_target`, the digest, dispositions, `hermes keryx` new commands (`auto-execute`, `undo`, `policy ...`, `metrics`, `digest --preview`, `validate-*`).
- Modify: `AGENTS.md` — update Commands, Project map (remove `collectors/`; note `src/policy/`), Architecture rules (three dispositions, disposition function, policy store, `hermes send` is the one new privilege), Security boundaries (absolute floor never silent; confidence derived from history; read_only silent-by-design). Keep the phrases the doc test asserts: `hermes-plugin/`, `hermes keryx doctor`, `./bin/opsctl doctor`, `plugin is the Hermes-facing adapter`, `Keryx remains a thin control surface over Hermes Kanban`, `keryx:keryx-worker`, `plugin-qualified Keryx skill names`.

**Commit:** `docs: README and AGENTS.md for v005`.

---

### Task 7.4: Rewrite `tests/unit/templates-and-docs.test.ts` and `tests/unit/skills.test.ts`

**Objective:** Make the assertion tests match the deleted `collectors/` folder and the v005 vocabulary.

**Files:**
- Modify: `tests/unit/templates-and-docs.test.ts` — remove every `collectors/...` path from `requiredFiles`, `activeDocsAndTemplates`, and all per-collector assertions (executable bit, scanner, cron-script placement, node-on-PATH). Keep and update: docs existence (`docs/*`, `deploy/*`, `AGENTS.md`), private-pattern scan, plugin-qualified skill-name conventions (still valid), the AGENTS.md phrase set, the architecture/security/operations phrase sets (update to the Task 7.2 lists), and the collector-authoring v2 JSON-example validation. Replace the `autonomy`-values test with a check that example option `reversibility`/`blast_radius` use allowed enums.
- Modify: `tests/unit/skills.test.ts` — update `requiredCriticalPhrases` (drop/replace as the skills change), keep the three-skill structure checks, frontmatter checks, plugin-qualified-name checks; update worker-skill assertions to reference the new silent/outcome/policy-proposal contract instead of the old prose-edit loop; keep CLI-validation-surface checks and extend with `validate-policy-decision`/`validate-outcome`.
- Test: run `npx vitest run tests/unit/templates-and-docs.test.ts tests/unit/skills.test.ts`.

**Commit:** `test: rewrite doc/skill assertion tests for v005 (no collectors folder)`.

---

### Task 7.5: Update `readme.test.ts`, `package-scripts.test.ts`, and any remaining v1 references

**Objective:** Catch the last stragglers.

**Files:**
- Modify: `tests/unit/readme.test.ts` — update asserted README phrases (schema name, removed sticky-block warning, new commands).
- Search: `search_files pattern="autonomy|action_item.v1|collectors/" path="."` — fix any remaining hits in `src/`, `tests/`, `docs/` (excluding `docs/archive/`).
- Test: full suite.

**Commit:** `test: update readme expectations and purge v1/collectors references`.

---

### Task 7.6: Plugin adapter root-check + skill list

**Objective:** The plugin's `_is_keryx_root` checks `schemas/action-item.v1.schema.json`, which no longer exists; and the skill list is fine but verify.

**Files:**
- Modify: `hermes-plugin/__init__.py` — change the root marker to `schemas/action-item.v2.schema.json`.
- Test: `tests/integration/hermes-plugin.test.ts` — update the expected marker file; assert the three skills still register.

**Commit:** `fix: plugin root marker points at action-item.v2 schema`.

---

## Final verification

### Task 8.1: Full green suite + builds

**Step 1:** `npm run lint` → expect clean.
**Step 2:** `npm test` → expect all green.
**Step 3:** `npm run typecheck` → expect clean.
**Step 4:** `npm run build` → expect success.
**Step 5:** `npm run e2e` → expect green (review log + interrupt deep link specs).
**Step 6:** `git diff --check`.

### Task 8.2: Live doctor + fresh-install smoke

**Step 1:** `./keryx-setup.sh --dry-run` → describes plugin install, bundle, `notify_target` selection, board ensure; no real cron/send.
**Step 2:** `./bin/opsctl doctor` (or `hermes keryx doctor`) → no FAIL.
**Step 3:** Create one `read_only` card via `auto-execute` against a fake/sandbox board and confirm it lands ready→done with an `outcome.v1` comment; `digest --preview` renders it under its category. (Use a temp `HERMES_HOME` fixture — do **not** mutate the real board beyond Phase 0.)

### Task 8.3: Archive the plan outcome

**Step 1:** Confirm `docs/archive/v005/PRD.md` and `docs/archive/v005/PLAN.md` are committed.
**Step 2:** Open a PR titled `feat: v005 attention-allocation surface`.

---

## Files likely to change (index)

**Schemas:** `schemas/action-item.v2.schema.json` (new, replaces v1), `dismissal-decision.v1`, `policy-decision.v1`, `outcome.v1`, `policy.v1`, `notification.v1`, `regret.v1` (new); `collector-state.v1` (extended). Delete `schemas/action-item.v1.schema.json`.

**Source:** `src/schemas/actionItem.ts` (rewrite) + new validators (`dismissalDecision.ts`, `policyDecision.ts`, `outcome.ts`, `policy.ts`, `notification.ts`, `regret.ts`); new `src/policy/{confidence,disposition,trackRecord,policyStore,metrics,promotion}.ts`; `src/opsctl/{commands,digest,interrupt,defaultResolver}.ts`; `src/hermes/adapter.ts`; `src/config.ts`; `src/server/routes.ts`; `src/web/{App.svelte,lib/api.ts,lib/filters.ts,lib/taskView.ts}`.

**Skills/docs:** `skills/keryx/{DESCRIPTION.md,keryx-worker,keryx-collector,keryx-collector-creator}/SKILL.md`; `docs/{architecture,security,operations,collector-authoring}.md`; `README.md`; `AGENTS.md`; `keryx-setup.sh`; `keryx.config.example.json`; `hermes-plugin/__init__.py`.

**Deleted:** `collectors/` (whole dir); `schemas/action-item.v1.schema.json`.

**Tests:** new `action-item-v2`, `confidence`, `disposition`, `track-record`, `policy-schema`, `policy-store`, `opsctl-auto-execute`, `opsctl-undo`, `opsctl-policy-propose`, `opsctl-validate`, `digest`, `interrupt`, `default-resolver`, `metrics`, `promotion`; rewrites of `templates-and-docs`, `skills`, `readme`, `schema-validation`, `hermes-adapter`, `server-routes`, `task-view`, `config`, `opsctl-execute/dismiss/create-card`, `hermes-plugin`, `server-api`, `setup-script`, e2e `inbox`.

## Risks, tradeoffs, open questions

- **Doc/skill assertion tests are brittle by design** (they grep exact phrases). Phase 7 must update prose and tests together; running the full suite mid-Phase-1–6 will show `templates-and-docs.test.ts`/`skills.test.ts` red until Phase 7. Each interim commit message should note this so reviewers aren't alarmed.
- **Worker behaviour lives in a skill, not TS** — it cannot be unit-tested directly; coverage is the skill-phrase tests plus opsctl/adapter tests for the creation/decision/outcome contracts. Manual smoke (Task 8.2 step 3) covers the execution leg.
- **Band thresholds** (`src/policy/confidence.ts` constants) are first-guess; expose as config in Task 6.2 and tune from metrics (PRD §16 q2). Do not hard-code in schema.
- **`hermes send` shape** must be verified against the installed Hermes CLI (`hermes send --help`) before Task 6.1 — adjust the exact argv if the real shape differs (e.g. requires `--target`/`--message` flags); keep the allowlist matcher exact to whatever the real shape is.
- **Kanban delete vs archive** (Task 0.2) depends on the installed Hermes verb set; confirm in step 1 of that task.
- **Read-layer vs tag-driven lanes** (PRD §16 q6): prefer deriving review-log/lane state from body/comments to avoid widening the allowlist; only add a tag adapter shape if Kanban requires it — decide during Task 3.7.
- **No backwards compatibility** is intentional per the requester; there is deliberately no v1 reader, no shim, and no dual-schema period.
