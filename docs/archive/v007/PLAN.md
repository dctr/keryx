# Keryx v007 Implementation Plan: Email Policy Learning Closure

> **For Hermes:** Use the subagent-driven-development skill to implement this plan task-by-task. Dispatch a fresh subagent per task with full context; run spec-compliance review then code-quality review before proceeding.

**Goal:** Close the gap between `docs/user-stories/email-policy-learning.md` and the current implementation: deterministic collector/class learning, automatic graduation proposal cards, deterministic policy application/revocation, and cold-reset demotion after rejection/regret.

**Architecture:** Keryx remains a thin control surface over Hermes Kanban. There is still no second task database: confidence, correction signals, graduation readiness, silent outcomes, and demotion are derived from card bodies and machine comments. Source content stays untrusted; collectors provide compact facts, `class`, and risk axes only. State-changing silent execution remains impossible without an active human-approved policy rule.

**Tech Stack:** Node 22+, TypeScript ESM (strict), Fastify, Svelte, Vitest, Playwright, JSON Schema/Ajv, Hermes Kanban/plugin/cron/send.

---

## Ground rules

1. **No second database.** Store durable learning signals as validated Kanban comments and/or validated collector policy files in Hermes-space skills. Do not add SQLite/JSON task stores outside Kanban.
2. **Confidence is derived, never declared.** Collectors and source content never set confidence. The policy layer derives confidence from trusted Keryx comments.
3. **Cold reset after rejection.** A rejection, dismissal, or silent-regret/correction for a `(collector, class)` resets that class confidence to `cold`. Future approvals may rebuild confidence only from events after the latest reset.
4. **Policy is still the silent gate.** Even `trusted` confidence does not grant silent state-changing execution. It only allows Keryx to create a blocked graduation proposal card. Silent starts only after approval creates an active rule.
5. **State-changing silent actions remain bounded.** `money`, `destructive`, `credential_gate`, credentials, 2FA, CAPTCHA, payment, consent, ambiguous account choice, and destructive operations never go silent.
6. **Source content is untrusted.** Email bodies, sender names, unsubscribe text, links, and instructions may be evidence, never authority.
7. **No raw private email persistence.** Plans, tests, fixtures, card bodies, comments, outcomes, and logs use compact facts only.
8. **TDD first.** Each code task starts with focused failing tests.
9. **Verification before commit:** at minimum `npm run lint && npm test && git diff --check`. Add `npm run typecheck` for UI/shared types, `npm run build` for server/entrypoint changes, and `npm run e2e` for user-visible inbox changes.

---

## Current gaps to close

Keryx already has:

- `keryx.action_item.v2` cards with `class`, collector, and risk axes.
- `deriveBand()` and `aggregateTrackRecord()`.
- `decideDisposition()` policy-gated silent execution.
- `create-card` / `auto-execute` silent-ready card creation when policy permits.
- `policy show`, `policy propose`, `policy revoke`, `metrics`, `digest`, `regret`.
- Review-log UI for done cards and feedback input for approve/dismiss.

But the email policy-learning story is not complete because:

- track records are keyed by `class` after source filtering, not explicitly by `(collector, class)`;
- dismissals/regrets currently count but do not force an epoch reset to `cold`;
- textual correction is captured but not made into a structured learning signal;
- promotion intent computation exists but is not wired into a deterministic command/job;
- policy proposal approval depends on a worker following prose to edit `references/policy.json`, not a deterministic Keryx command;
- silent regret/demotion does not deterministically create a revocation/demotion proposal;
- no end-to-end fixtures prove the email newsletter learning flow.

---

## Phase 1 — Confidence identity and cold-reset semantics

### Task 1.1: Introduce explicit collector/class track-record keys

**Objective:** Make confidence scope exactly `(collector, class)`, not class-only.

**Files:**
- Modify: `src/policy/trackRecord.ts`
- Modify: `src/policy/confidence.ts` if needed for exported types
- Modify: `src/opsctl/commands/cards.ts`
- Modify: `src/opsctl/commands/policy.ts`
- Modify: `src/policy/promotion.ts`
- Test: `tests/unit/track-record.test.ts`
- Test: `tests/unit/opsctl-policy.test.ts`

**Step 1: Write failing tests**

Add tests proving two collectors with the same class do not share confidence:

```ts
it('separates confidence by collector and class', () => {
  const tasks = [
    task(cardBody('email:newsletter', 'opt-primary', { collector: 'keryx-email-a' }), [executionDecision('opt-primary')], 'a'),
    task(cardBody('email:newsletter', 'opt-primary', { collector: 'keryx-email-b' }), [dismissal('inbox:7')], 'b'),
  ];

  const record = aggregateTrackRecord(tasks);

  expect(record['keryx-email-a\u0000email:newsletter']).toEqual({ approved: 1, overridden: 0, dismissed: 0, regret: 0 });
  expect(record['keryx-email-b\u0000email:newsletter']).toEqual({ approved: 0, overridden: 0, dismissed: 1, regret: 0 });
});
```

Use a helper such as `trackRecordKey(collector, cls)` rather than hardcoding the separator at call sites.

**Step 2: Run targeted tests**

Run: `npx vitest run tests/unit/track-record.test.ts tests/unit/opsctl-policy.test.ts`

Expected: FAIL until keying is changed.

**Step 3: Implement key helpers**

Add exports in `src/policy/trackRecord.ts`:

```ts
const KEY_SEPARATOR = '\u0000';

export function trackRecordKey(collector: string, cls: string): string {
  return `${collector}${KEY_SEPARATOR}${cls}`;
}

export function splitTrackRecordKey(key: string): { collector: string; class: string } {
  const index = key.indexOf(KEY_SEPARATOR);
  if (index === -1) return { collector: '', class: key };
  return { collector: key.slice(0, index), class: key.slice(index + KEY_SEPARATOR.length) };
}
```

Update `aggregateTrackRecord()` to bucket by `trackRecordKey(card.value.collector, card.value.class)`.

**Step 4: Update call sites**

- In `src/opsctl/commands/cards.ts`, `deriveBandForClass()` should look up `trackRecordKey(card.collector, card.class)`.
- In `src/opsctl/commands/policy.ts`, `policy show` should display classes for the selected collector only, but it should derive from keyed records.
- In `src/policy/promotion.ts`, promotion input should be keyed by collector/class or accept collector separately and operate only on that collector.

**Step 5: Verify**

Run:

```sh
npx vitest run tests/unit/track-record.test.ts tests/unit/opsctl-policy.test.ts tests/unit/opsctl-create-card.test.ts tests/unit/opsctl-auto-execute.test.ts tests/unit/promotion.test.ts
npm run lint
```

**Step 6: Commit**

```sh
git add src/policy src/opsctl tests/unit
git commit -m "fix: scope confidence by collector and class"
```

---

### Task 1.2: Make dismissal/rejection/regret reset confidence to cold by epoch

**Objective:** A rejection does not merely lower confidence. It resets the class to `cold`; later approvals rebuild from after the reset.

**Files:**
- Modify: `src/policy/trackRecord.ts`
- Modify: `src/policy/confidence.ts`
- Modify: `tests/unit/confidence.test.ts`
- Modify: `tests/unit/track-record.test.ts`
- Modify: `tests/unit/promotion.test.ts`

**Semantics:**

- A reset event is any valid:
  - `keryx.dismissal_decision.v1` on a card of that `(collector, class)`;
  - `keryx.regret.v1` on a card of that `(collector, class)`;
  - later tasks may add an explicit correction/rejection schema, and it should also be a reset event.
- `aggregateTrackRecord()` should only count approvals/overrides after the latest reset event for that `(collector, class)`.
- The returned record should preserve reset evidence for metrics, e.g. `{ approved, overridden, dismissed, regret, reset_at }`, or keep the existing public shape and add a parallel helper. Prefer extending the type only if tests and UI need to display reset state.
- `deriveBand()` should return `cold` whenever the effective post-reset approvals are below thresholds. It should not inspect all-time approvals before the latest rejection.

**Step 1: Write failing tests**

```ts
it('resets confidence to cold after a dismissal even with many prior approvals', () => {
  const tasks = [
    ...Array.from({ length: 10 }, (_, i) =>
      task(cardBody(CLASS), [executionDecision('opt-primary')], `approve-${i}`),
    ),
    task(cardBody(CLASS), [dismissal('inbox:reset')], 'reset'),
  ];

  const record = aggregateTrackRecord(tasks)[trackRecordKey('keryx-email', CLASS)];
  expect(deriveBand(record)).toBe('cold');
});

it('rebuilds confidence only from approvals after the latest reset', () => {
  const tasks = [
    ...approvals(10, 'before'),
    task(cardBody(CLASS), [dismissal('inbox:reset')], 'reset'),
    ...approvals(3, 'after'),
  ];

  const record = aggregateTrackRecord(tasks)[trackRecordKey('keryx-email', CLASS)];
  expect(record.approved).toBe(3);
  expect(deriveBand(record)).toBe('warming');
});

it('resets active-rule promotion state to demotion intent after silent regret', () => {
  const key = trackRecordKey('keryx-email', 'email:newsletter');
  const intents = computePromotionIntents({ [key]: { approved: 0, overridden: 0, dismissed: 0, regret: 1 } }, [activeRule]);
  expect(intents).toContainEqual(expect.objectContaining({ kind: 'demote', band: 'cold' }));
});
```

**Step 2: Implement event ordering**

Kanban comments have `created_at`; tasks also have timestamps. Use the most reliable available ordering:

1. comment `created_at` if present;
2. task `updated_at` / `created_at` if present;
3. stable iteration order as final fallback.

For each `(collector, class)`, collect events:

```ts
type TrackEvent =
  | { kind: 'approval'; optionKind: 'primary' | 'override'; at: number }
  | { kind: 'reset'; resetKind: 'dismissal' | 'regret' | 'correction'; at: number };
```

Find the latest reset timestamp, then count only approvals/overrides after it. Keep `dismissed` and `regret` counts for display/metrics, but they must not let old approvals sustain confidence.

**Step 3: Update `deriveBand()` comments and tests**

Change comments in `src/policy/confidence.ts` from “regret caps at warming” to “reset events cold-start the effective record”. If `deriveBand()` receives an already epoch-filtered record, it can remain simple; document that invariant clearly.

**Step 4: Verify**

Run:

```sh
npx vitest run tests/unit/confidence.test.ts tests/unit/track-record.test.ts tests/unit/promotion.test.ts tests/unit/opsctl-policy.test.ts tests/unit/metrics.test.ts
npm run lint
```

**Step 5: Commit**

```sh
git add src/policy tests/unit
git commit -m "fix: reset confidence to cold after rejection or regret"
```

---

## Phase 2 — Structured corrections without a second store

### Task 2.1: Add a structured correction/comment schema

**Objective:** Preserve textual rejection/feedback as durable learning input without editing collector skills directly and without inventing corrections when the user gave none.

**Files:**
- Create: `schemas/correction.v1.schema.json`
- Create: `src/schemas/correction.ts`
- Modify: `src/schemas/validatorBySchema.ts`
- Modify: `src/opsctl/commands/validate.ts`
- Modify: `src/opsctl/commands.ts` help/schema list
- Test: `tests/unit/schema-validation.test.ts`
- Test: `tests/unit/opsctl-validate.test.ts`

**Schema shape:**

```json
{
  "schema": "keryx.correction.v1",
  "collector": "keryx-email",
  "class": "email:newsletter_unsubscribe_trash",
  "external_id": "imap:INBOX:123",
  "idempotency_key": "keryx:email:imap:INBOX:123",
  "kind": "rejection_feedback",
  "note": "Do not unsubscribe from professional association newsletters.",
  "recorded_by": "User",
  "recorded_via": "keryx-web",
  "recorded_at": "2026-07-05T00:00:00.000Z"
}
```

Allowed `kind` values:

- `approval_feedback`
- `rejection_feedback`
- `silent_regret_feedback`
- `policy_rejection_feedback`

**Important:** a correction is advisory learning data. It is not a policy rule and never authorizes execution.

**Step 1:** Write schema/validator tests first.

**Step 2:** Implement schema + validator.

**Step 3:** Wire `validate-correction` and `schema correction`.

**Step 4:** Verify:

```sh
npx vitest run tests/unit/schema-validation.test.ts tests/unit/opsctl-validate.test.ts
npm run lint
```

**Step 5:** Commit:

```sh
git add schemas src/schemas src/opsctl tests/unit
git commit -m "feat: add structured correction comment schema"
```

---

### Task 2.2: Record correction comments from approve/dismiss/regret flows

**Objective:** When the user supplies text feedback, write a separate `keryx.correction.v1` comment. When no feedback is supplied, write no correction.

**Files:**
- Modify: `src/opsctl/commands/lifecycle.ts`
- Modify: `src/opsctl/commands/regretCmd.ts`
- Modify: `src/opsctl/builders.ts`
- Modify: `src/server/routes.ts` only if API body validation needs naming changes
- Test: `tests/unit/opsctl-execute.test.ts`
- Test: `tests/unit/opsctl-dismiss.test.ts`
- Test: `tests/unit/opsctl-regret.test.ts`
- Test: `tests/e2e/inbox.spec.ts`

**Behavior:**

- `execute <task_id> --feedback <text>`:
  - still writes `keryx.execution_decision.v1` with `user_feedback`;
  - additionally writes `keryx.correction.v1` with `kind=approval_feedback`.
- `dismiss <task_id> --reason <text>`:
  - writes `keryx.dismissal_decision.v1`;
  - writes `keryx.correction.v1` with `kind=rejection_feedback`;
  - resets confidence to cold via Task 1.2 semantics.
- `regret <task_id> --note <text>`:
  - writes `keryx.regret.v1`;
  - writes `keryx.correction.v1` with `kind=silent_regret_feedback`;
  - resets confidence to cold via Task 1.2 semantics.
- Empty feedback/reason/note must not create a synthetic correction.

**Step 1:** Add failing tests that count comments and validate correction bodies.

**Step 2:** Add a `buildCorrection()` helper in `src/opsctl/builders.ts`.

**Step 3:** Wire lifecycle/regret commands.

**Step 4:** Verify:

```sh
npx vitest run tests/unit/opsctl-execute.test.ts tests/unit/opsctl-dismiss.test.ts tests/unit/opsctl-regret.test.ts tests/e2e/inbox.spec.ts
npm run typecheck
npm run lint
```

**Step 5:** Commit:

```sh
git add src/opsctl src/server tests/unit tests/e2e
git commit -m "feat: record structured correction feedback"
```

---

## Phase 3 — Deterministic graduation and demotion commands

### Task 3.1: Add promotion scan command

**Objective:** Wire `computePromotionIntents()` into a deterministic `policy scan` command that creates blocked graduation/demotion proposal cards.

**Files:**
- Modify: `src/opsctl/commands/policy.ts`
- Modify: `src/opsctl/commands.ts` help text
- Modify: `src/policy/promotion.ts`
- Test: `tests/unit/opsctl-policy-scan.test.ts`
- Test: `tests/unit/promotion.test.ts`

**Command:**

```sh
hermes keryx policy scan <collector> [--preview]
```

Direct fallback:

```sh
./bin/opsctl policy scan <collector> [--preview]
```

**Behavior:**

- Load collector policy via `loadPolicy(collector)`.
- List tasks with comments for that collector/source.
- Aggregate `(collector, class)` track record with cold-reset epochs.
- Compute promotion/demotion intents.
- `--preview` prints stable text/JSON with no mutation.
- Without `--preview`, create blocked proposal cards:
  - `shadow -> active`: graduation card for active silent rule.
  - `active -> shadow` or `active -> revoked`: demotion/revocation card after cold reset.
  - No rule -> shadow remains optional; prefer not to auto-create first shadow unless a source-specific policy skeleton exists.

**User-facing card requirements:**

Graduation cards must include:

- proposed rule id;
- collector;
- class;
- evidence summary: approvals since latest reset, overrides since latest reset, latest reset if any;
- risk bounds;
- exclusions;
- undo/correction path;
- digest behavior;
- revocation path.

Demotion/revocation cards must include:

- rejection/regret that caused cold reset;
- rule currently active;
- proposed target state;
- expected fallback behavior: future matching cards return to review.

**Step 1:** Write failing tests for preview and mutation paths.

**Step 2:** Implement command.

**Step 3:** Verify:

```sh
npx vitest run tests/unit/opsctl-policy-scan.test.ts tests/unit/promotion.test.ts tests/unit/opsctl-policy.test.ts
npm run lint
```

**Step 4:** Commit:

```sh
git add src/policy src/opsctl tests/unit
git commit -m "feat: scan policy history for graduation and demotion proposals"
```

---

### Task 3.2: Add a deterministic policy-apply command

**Objective:** Approving a policy proposal should cause a deterministic Keryx command to write `references/policy.json`, not rely on a worker interpreting prose.

**Files:**
- Modify: `src/opsctl/commands/policy.ts`
- Modify: `src/opsctl/commands.ts` help text
- Modify: `src/policy/policyStore.ts`
- Test: `tests/unit/opsctl-policy-apply.test.ts`
- Integration test if practical: `tests/integration/server-api.test.ts`

**Command:**

```sh
hermes keryx policy apply <task_id>
```

**Behavior:**

- Show/read the proposal task.
- Validate body as `keryx.action_item.v2` with class either:
  - `policy:rule-proposal`
  - `policy:rule-revocation`
  - `policy:rule-demotion`
- Require latest trusted human `keryx.execution_decision.v1` selecting the appropriate option.
- Extract structured policy rule data from `source_refs` or a dedicated field in the proposal card.
- Load existing policy file or `emptyPolicy()`.
- Apply change deterministically:
  - add/update active rule for approved graduation;
  - set state to `shadow` or remove rule for demotion/revocation;
  - bump `version` and `updated_at`.
- Validate resulting policy with `validatePolicy()` before writing.
- Write only under the resolved Hermes-space collector skill directory.
- Add a `keryx.outcome.v1` comment to the proposal card and mark it `done`.

**Step 1:** Write failing tests with temp `HERMES_HOME`.

**Step 2:** Add safe write helper to `policyStore.ts`:

```ts
export function writePolicy(policy: Policy, options: PolicyStoreOptions = {}): WritePolicyResult;
```

Use atomic write: write temp file in same directory then rename.

**Step 3:** Implement `policy apply`.

**Step 4:** Update policy proposal cards so their selected option's `execution_prompt` simply says: run `hermes keryx policy apply <task_id>` and do not hand-edit policy JSON.

**Step 5:** Verify:

```sh
npx vitest run tests/unit/opsctl-policy-apply.test.ts tests/unit/opsctl-policy-propose.test.ts tests/unit/policy-store.test.ts
npm run lint
```

**Step 6:** Commit:

```sh
git add src/policy src/opsctl tests/unit
git commit -m "feat: apply approved policy changes deterministically"
```

---

## Phase 4 — Worker and cron integration

### Task 4.1: Update `keryx-worker` skill to use deterministic policy commands

**Objective:** Worker guidance should stop telling agents to hand-edit policy files and instead call deterministic Keryx commands.

**Files:**
- Modify: `skills/keryx/keryx-worker/SKILL.md`
- Modify: `skills/keryx/keryx-collector-creator/SKILL.md`
- Test: `tests/unit/skills.test.ts`
- Test: `tests/unit/templates-and-docs.test.ts`

**Behavior changes:**

- For approved policy proposal cards, worker runs `hermes keryx policy apply <task_id>`.
- For normal executed action cards, after writing outcome, worker may run `hermes keryx policy scan <collector> --preview`; if preview reports a proposal and the task context permits, run without preview to create the blocked proposal card.
- For rejected/dismissed/silent-regret cards, worker should not try to decrement confidence. The cold reset is derived from comments. It may run `policy scan` to create demotion/revocation proposals.

**Step 1:** Add doc/skill tests asserting the new commands are mentioned and manual policy editing is not recommended.

**Step 2:** Patch skills.

**Step 3:** Verify:

```sh
npx vitest run tests/unit/skills.test.ts tests/unit/templates-and-docs.test.ts
npm run lint
```

**Step 4:** Commit:

```sh
git add skills tests/unit
git commit -m "docs: route policy changes through deterministic commands"
```

---

### Task 4.2: Add optional scheduled policy-scan cron guidance

**Objective:** Make graduation/demotion proposal creation reliable even when workers do not run long enough to scan policy.

**Files:**
- Modify: `README.md`
- Modify: `docs/operations.md`
- Modify: `docs/collector-authoring.md`
- Modify: `skills/keryx/keryx-collector-creator/SKILL.md`
- Test: `tests/unit/readme.test.ts`
- Test: `tests/unit/templates-and-docs.test.ts`

**Recommended cron shape:**

```text
Name: keryx-policy-scan-<source>
Schedule: daily or every 6h
Prompt: Run `hermes keryx policy scan keryx-<source>`; report only errors.
Skills: keryx:keryx-collector
Delivery: local or origin, not interrupt
```

**Step 1:** Add docs tests for `policy scan` and cold-reset wording.

**Step 2:** Update docs.

**Step 3:** Verify:

```sh
npx vitest run tests/unit/readme.test.ts tests/unit/templates-and-docs.test.ts
npm run lint
```

**Step 4:** Commit:

```sh
git add README.md docs skills tests/unit
git commit -m "docs: document policy scan scheduling"
```

---

## Phase 5 — UI/API support for policy learning

### Task 5.1: Surface confidence epoch and reset state in policy API/UI

**Objective:** The UI should show that a class is cold after rejection/regret and why.

**Files:**
- Modify: `src/web/lib/api.ts`
- Modify: `src/web/App.svelte`
- Modify: `src/server/routes.ts` if policy response shape changes
- Modify: `src/opsctl/commands/policy.ts`
- Test: `tests/unit/task-view.test.ts` if helpers change
- Test: `tests/e2e/inbox.spec.ts`
- Test: `tests/integration/server-api.test.ts`

**UI content:**

For each policy class, show:

- band: cold/warming/trusted;
- approvals since latest reset;
- overrides since latest reset;
- latest reset type and time, if any;
- active/shadow rule state;
- `Scan for graduation/demotion` action if API support exists, otherwise CLI hint.

**Step 1:** Add failing API/UI tests for cold reset display.

**Step 2:** Extend policy response.

**Step 3:** Render compact UI text.

**Step 4:** Verify:

```sh
npx vitest run tests/integration/server-api.test.ts tests/e2e/inbox.spec.ts
npm run typecheck
npm run lint
```

**Step 5:** Commit:

```sh
git add src/server src/web src/opsctl tests
git commit -m "feat: show confidence reset state in policy UI"
```

---

### Task 5.2: Add API route for policy scan preview/proposal creation

**Objective:** Let the web inbox trigger deterministic policy scans without shell access.

**Files:**
- Modify: `src/server/routes.ts`
- Modify: `src/web/lib/api.ts`
- Modify: `src/web/App.svelte`
- Test: `tests/integration/server-api.test.ts`
- Test: `tests/e2e/inbox.spec.ts`

**Route:**

```http
POST /api/policy/:collector/scan
```

Body:

```json
{ "preview": true }
```

or:

```json
{ "preview": false }
```

**Behavior:**

- Validate collector name.
- Delegate to `runOpsctl(['policy', 'scan', collector, '--preview'])` for preview.
- Delegate to `runOpsctl(['policy', 'scan', collector])` for mutation.
- Return command result using existing command-result plumbing.

**Step 1:** Add integration tests.

**Step 2:** Add API helper and UI button.

**Step 3:** Verify:

```sh
npx vitest run tests/integration/server-api.test.ts tests/e2e/inbox.spec.ts
npm run typecheck
npm run lint
```

**Step 4:** Commit:

```sh
git add src/server src/web tests
git commit -m "feat: expose policy scan in the web UI"
```

---

## Phase 6 — Email collector generated artifact contract

### Task 6.1: Strengthen collector creator requirements for email

**Objective:** The collector creator should produce an email collector that can satisfy the user story when invoked, without committing a sample email collector into the Keryx repository.

**Files:**
- Modify: `skills/keryx/keryx-collector-creator/SKILL.md`
- Modify: `docs/collector-authoring.md`
- Test: `tests/unit/skills.test.ts`
- Test: `tests/unit/templates-and-docs.test.ts`

**Generated email collector must include:**

- source-specific Hermes-space skill: `keryx-collector-email`;
- fixture harness with compact fake email facts only;
- source cursor state;
- exact-dismiss state;
- idempotency keys: `keryx:email:<immutable-message-id>`;
- policy skeleton in `references/policy.json` with state-changing rules as `shadow` only;
- correction handling notes: correction comments are inputs to future classification, never direct execution authority;
- cold-reset rule: any rejected/dismissed/regretted class restarts confidence from `cold`.

**Step 1:** Add doc/skill assertion tests.

**Step 2:** Update docs/skill.

**Step 3:** Verify:

```sh
npx vitest run tests/unit/skills.test.ts tests/unit/templates-and-docs.test.ts
npm run lint
```

**Step 4:** Commit:

```sh
git add skills docs tests/unit
git commit -m "docs: define email collector learning artifact contract"
```

---

### Task 6.2: Add fixture-level acceptance tests for generated email collector expectations

**Objective:** Add programmatic tests that validate the contract of generated collector artifacts using fake Hermes home fixtures, without creating a real collector or real cron job.

**Files:**
- Create: `tests/integration/email-policy-learning.test.ts`
- Modify: test helpers if needed under `tests/fixtures` or `tests/helpers`

**Tests:**

1. Fake Hermes home with generated `keryx-collector-email/references/policy.json` validates as `keryx.policy.v1` and every state-changing silent-eligible rule is `shadow` by default.
2. Fake newsletter card without active policy creates blocked review card.
3. Ten approvals after no reset produce `trusted` and `policy scan --preview` reports graduation candidate.
4. A dismissal after ten approvals resets band to `cold`; `policy scan --preview` reports no graduation candidate.
5. After dismissal, three new approvals produce only `warming`, not `trusted`.
6. Active rule + trusted band permits silent card creation.
7. Silent regret resets band to `cold` and `policy scan --preview` reports demotion/revocation candidate.
8. Absolute-floor email cards never resolve to silent.

**Step 1:** Create fixtures and failing tests.

**Step 2:** Implement helper changes required by prior phases.

**Step 3:** Verify:

```sh
npx vitest run tests/integration/email-policy-learning.test.ts
npm run lint
```

**Step 4:** Commit:

```sh
git add tests/integration
git commit -m "test: cover email policy learning acceptance flow"
```

---

## Phase 7 — Documentation alignment

### Task 7.1: Update user story to reflect cold-reset semantics

**Objective:** Align `docs/user-stories/email-policy-learning.md` with the requested rule: after rejection, the class falls back to `cold`.

**Files:**
- Modify: `docs/user-stories/email-policy-learning.md`
- Test: `tests/unit/templates-and-docs.test.ts` if doc assertions exist or are added

**Required edits:**

Replace “lowers confidence” language with explicit cold reset:

- rejection/dismissal resets confidence for that `(collector, class)` to `cold`;
- if rejection includes text, correction is stored as structured learning input;
- if rejection has no text, no correction is invented, but the cold reset still applies;
- after cold reset, later approvals rebuild confidence from that point only.

Also update silent-regret language:

- bad silent action resets class confidence to `cold`;
- active rule should be demoted/revoked by proposal before more silent actions occur.

**Step 1:** Patch the doc.

**Step 2:** Add/adjust doc tests if current tests assert the old wording.

**Step 3:** Verify:

```sh
npx vitest run tests/unit/templates-and-docs.test.ts tests/unit/readme.test.ts
npm run lint
```

**Step 4:** Commit:

```sh
git add docs tests/unit
git commit -m "docs: clarify rejection resets policy confidence to cold"
```

---

### Task 7.2: Update README, architecture, security, and operations docs

**Objective:** Ensure public docs match the implemented v007 flow.

**Files:**
- Modify: `README.md`
- Modify: `docs/architecture.md`
- Modify: `docs/security.md`
- Modify: `docs/operations.md`
- Modify: `docs/collector-authoring.md`
- Modify: `AGENTS.md` if commands/project structure/safety boundaries change
- Test: `tests/unit/readme.test.ts`
- Test: `tests/unit/templates-and-docs.test.ts`

**Required documentation:**

- `policy scan <collector> [--preview]`
- `policy apply <task_id>`
- `validate-correction` and `schema correction`
- confidence scope: exact `(collector, class)`
- cold-reset semantics
- deterministic policy apply path
- review log and digest access
- generated email collector remains in Hermes space, not committed in repo

**Step 1:** Update docs.

**Step 2:** Update doc assertion tests.

**Step 3:** Verify:

```sh
npx vitest run tests/unit/readme.test.ts tests/unit/templates-and-docs.test.ts
npm run lint
```

**Step 4:** Commit:

```sh
git add README.md docs AGENTS.md tests/unit
git commit -m "docs: document v007 policy learning workflow"
```

---

## Phase 8 — Final verification

### Task 8.1: Run full local verification

**Objective:** Prove v007 is integrated and does not regress existing behavior.

**Commands:**

```sh
npm run lint
npm test
npm run typecheck
npm run build
git diff --check
```

Run `npm run e2e` if Tasks 5.1 or 5.2 changed visible inbox behavior. They likely do, so expect to run:

```sh
npm run e2e
```

**Expected:** all pass.

**Commit if needed:**

```sh
git add -A
git commit -m "test: verify v007 policy learning flow"
```

---

### Task 8.2: Manual dry-run script with fake Hermes home

**Objective:** Demonstrate the email learning lifecycle without touching real email, real Hermes cron jobs, or the real Keryx board.

**Steps:**

1. Create temp `HERMES_HOME`.
2. Write fake `keryx-collector-email/references/policy.json` with a shadow rule.
3. Use fake Hermes runner or existing integration harness to create:
   - ten approved newsletter cards;
   - no reset events.
4. Run:

```sh
HERMES_HOME=<tmp> ./bin/opsctl policy show keryx-email --json
HERMES_HOME=<tmp> ./bin/opsctl policy scan keryx-email --preview
```

5. Add dismissal/regret event.
6. Re-run show/scan and verify band is `cold`, not `warming` or `trusted`.
7. Verify no real board, cron, or email side effects occurred.

**Expected:** output clearly demonstrates:

- approvals can build to trusted;
- policy scan proposes graduation;
- rejection resets to cold;
- active rule demotion/revocation is proposed after silent regret.

---

## Open decisions

1. **Reset event naming:** Use existing `dismissal_decision` and `regret` as reset events immediately. Add `correction.v1` as learning context, not as the reset authority. This avoids ambiguity and preserves no-feedback resets.
2. **Demotion target:** After silent regret on an active rule, prefer proposal to revoke the rule entirely rather than merely set `shadow`. If implementation keeps `shadow`, disposition still falls back to review because band is `cold`; revocation is clearer to the user.
3. **Policy scan scheduling:** Do not create real cron jobs in setup. Document optional `keryx-policy-scan-<source>` cron creation after collector dry-run.
4. **Email access:** Keep email collector generation source-agnostic. It may use Himalaya, IMAP scripts, browser, or another source-specific mechanism, but generated artifacts must keep credentials outside cards/comments/logs.

---

## Definition of done

v007 is complete when:

- confidence is explicitly scoped by `(collector, class)`;
- rejection/dismissal/regret resets that scope to `cold` and future approvals rebuild only after the reset;
- textual feedback is captured as structured correction data when supplied;
- no-feedback rejection still resets to `cold` but invents no correction;
- `policy scan` deterministically creates graduation/demotion proposal cards;
- `policy apply` deterministically writes validated policy changes after proposal approval;
- active state-changing silent execution still requires active policy + sufficient post-reset confidence + risk bounds;
- silent regret produces a cold reset and demotion/revocation path;
- digest/review-log visibility remains intact;
- email policy-learning fixtures cover the happy path and rejection/reset path;
- README/docs/skills/user story agree with the implemented behavior;
- `npm run lint`, `npm test`, `npm run typecheck`, `npm run build`, `git diff --check`, and relevant e2e tests pass.
