# v006 Codebase Simplification Implementation Plan

> **For Hermes:** Use the subagent-driven-development skill to implement this plan task-by-task. Each task is bite-sized and independently committable. Run the stated verification before committing.

**Goal:** Remove cross-module duplication, split the `commands.ts` god file, harden two runtime risks in the Hermes adapter, and fix targeted efficiency/silent-failure issues — without changing any user-facing CLI output, schema strings, or the local-only security posture.

**Architecture:** Keryx stays a thin control surface over Hermes Kanban. This work is structural only: extract shared helpers into new small modules, split one large dispatcher into command-group files behind a thin router, and tighten subprocess lifecycle. No new task store, no new privileges, no behaviour change to the disposition function.

**Tech Stack:** Node 22+, TypeScript ESM (strict), Svelte, Fastify, Vitest, Playwright, ajv (schemas).

---

## Ground rules (read before starting any task)

These are derived from `AGENTS.md` and the review. Violating one of these turns a SAFE task into a regression.

1. **CLI output is a contract.** Strings emitted by `opsctl` (`FAIL invalid action card:`, `OK valid ...`, doctor lines, digest text) are asserted **verbatim** in `tests/unit` and `tests/integration`. Any extraction must reproduce byte-for-byte output. The `ok()`/`fail()` helpers in `src/opsctl/output.ts` already append a trailing newline — do not double-add it.
2. **Schema strings are contracts.** `keryx.action_item.v2`, `keryx.execution_decision.v1`, `keryx.policy_decision.v1`, `keryx.dismissal_decision.v1`, `keryx.outcome.v1`, etc. Never rename them during a refactor.
3. **Malformed card bodies must stay visible.** Parsers return an error message to the caller; they never silently drop a malformed body. Preserve this in every extracted parser.
4. **`disposition.ts` is safety-critical and out of scope.** Do not touch `src/policy/disposition.ts` decision-order logic in this plan.
5. **Local-only posture is a contract.** Do not weaken the `127.0.0.1` bind or the host guard (`src/server/hostGuard.ts`).
6. **The Hermes adapter is a narrow allowlist.** Do not add generic shell/Hermes passthroughs. New subprocess behaviour (timeout, concurrency cap) wraps existing calls only.
7. **Verification per task:** at minimum `npm run lint && npm test`. Add `npm run typecheck` for any Svelte/shared-type change, `npm run build` for entrypoint/bundling changes, `npm run e2e` for visible inbox behaviour. Stop on first red and revert that task.
8. **Commit after every task** using conventional commits.

---

# TIER 1 — High value, low risk (do first)

## Task 1.1: Create a shared object/string util module

**Objective:** Have one home for `isPlainObject`, `firstString`, `isNonEmptyString` so the 4 copies collapse to one import.

**Files:**
- Create: `src/util/object.ts`
- Test: `tests/unit/util-object.test.ts`

**Step 1: Write failing test**

```ts
import { describe, expect, it } from 'vitest';
import { firstString, isNonEmptyString, isPlainObject } from '../../src/util/object';

describe('object util', () => {
  it('isPlainObject rejects arrays and null', () => {
    expect(isPlainObject({})).toBe(true);
    expect(isPlainObject([])).toBe(false);
    expect(isPlainObject(null)).toBe(false);
  });

  it('firstString returns the first trimmed non-empty string', () => {
    expect(firstString(undefined, '  ', ' hello ', 'x')).toBe('hello');
    expect(firstString(1, null)).toBeUndefined();
  });

  it('isNonEmptyString checks trimmed length', () => {
    expect(isNonEmptyString(' a ')).toBe(true);
    expect(isNonEmptyString('   ')).toBe(false);
  });
});
```

**Step 2: Run to verify failure**

Run: `npx vitest run tests/unit/util-object.test.ts`
Expected: FAIL — module not found.

**Step 3: Implement**

> **Decision required first.** The current copies disagree on trimming: `adapter.ts:506` `firstString` does **not** trim; `routes.ts:481` **does** (`?.trim()`). Audit both call sites. The trimming version is the safer superset (cron field values shouldn't carry whitespace). Adopt the **trimming** version as canonical, and verify in Step 4 that adapter callers tolerate trimmed values (they only compare/emit them). If any adapter caller depends on untrimmed output, keep this finding for OUT_OF_SCOPE instead.

```ts
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export function firstString(...values: unknown[]): string | undefined {
  return values.find(isNonEmptyString)?.trim();
}
```

**Step 4: Verify pass**

Run: `npx vitest run tests/unit/util-object.test.ts` → PASS.

**Step 5: Replace the copies (one file at a time, lint+test after each)**

- `src/hermes/adapter.ts:506-516` — delete local `firstString`/`isPlainObject`/`isNonEmptyString`, import from `../util/object`.
- `src/server/routes.ts:481-487` — delete local `firstString`/`isPlainObject`, import.
- `src/config.ts:232-234` — delete local `isPlainObject`, import.
- `src/opsctl/commands.ts:2157-2163` — delete local `firstString`/`isPlainObject`, import.

After **each** file: `npm run lint && npm test`. The trimming change is the only behavioural risk — `npm test` covers the cron/delivery formatting paths that exercise these.

**Step 6: Commit**

```bash
git add src/util/object.ts tests/unit/util-object.test.ts src/hermes/adapter.ts src/server/routes.ts src/config.ts src/opsctl/commands.ts
git commit -m "refactor: extract shared object/string util, dedupe 4 copies"
```

---

## Task 1.2: Extract a shared comment-body parser

**Objective:** Collapse the 4 verbatim `parseCommentBody`/`parseJsonBody` copies into one exported helper. Pure, behaviour-identical, preserves "skip non-matching machine comments" semantics.

**Files:**
- Create: `src/hermes/commentBody.ts`
- Test: `tests/unit/comment-body.test.ts`
- Modify: `src/policy/trackRecord.ts:24-31`, `src/opsctl/digest.ts:122-129`, `src/opsctl/defaultResolver.ts:171-180`, `src/policy/metrics.ts:51-58`

**Step 1: Write failing test**

```ts
import { describe, expect, it } from 'vitest';
import { parseCommentBody } from '../../src/hermes/commentBody';

describe('parseCommentBody', () => {
  it('parses JSON string bodies', () => {
    expect(parseCommentBody({ body: '{"a":1}' } as never)).toEqual({ a: 1 });
  });
  it('returns null for non-string body', () => {
    expect(parseCommentBody({ body: 42 } as never)).toBeNull();
  });
  it('returns null for invalid JSON (does not throw)', () => {
    expect(parseCommentBody({ body: 'not json' } as never)).toBeNull();
  });
});
```

**Step 2: Run** → FAIL (module not found).

**Step 3: Implement**

```ts
import type { KanbanComment } from './types';

// Parses a Kanban comment body as JSON, or null when the body is absent or not
// valid JSON. Used by the read-side aggregators (track record, digest, metrics,
// default-resolve) to scan machine-written decision/outcome comments. Returning
// null for non-matching bodies is intentional: these are best-effort scans over
// a mixed comment stream, NOT the card-body validation path (which must surface
// malformed bodies to the caller).
export function parseCommentBody(comment: KanbanComment): unknown {
  if (typeof comment.body !== 'string') return null;
  try {
    return JSON.parse(comment.body) as unknown;
  } catch {
    return null;
  }
}
```

**Step 4: Run** → PASS.

**Step 5: Replace copies, lint+test after each.** Delete each local definition and import `parseCommentBody` from `../hermes/commentBody` (adjust relative depth). In `metrics.ts`, rename the call site from `parseJsonBody` to `parseCommentBody` (it takes `raw: unknown` there — keep a thin local adapter if the signature differs, or change the call to pass the comment). Confirm `npm test` green after each.

**Step 6: Commit**

```bash
git commit -am "refactor: extract shared parseCommentBody, dedupe 4 copies"
```

---

## Task 1.3: Extract shared task-body + cron-normalisation helpers

**Objective:** Remove the verbatim duplication between `src/opsctl/commands.ts` and `src/server/routes.ts` for `parseActionItemFromTask`, `taskStatus`, and the cron-normalisation pipeline. Aligns with the AGENTS rule that web/server should route through shared logic.

**Files:**
- Create: `src/hermes/taskBody.ts` (parseActionItemFromTask, taskStatus, stringOrNull)
- Create: `src/hermes/cronNormalise.ts` (shared cron candidate + normaliser core)
- Modify: `src/server/routes.ts:357-475`, `src/opsctl/commands.ts:2061-2148`

**Notes / care:**
- `parseActionItemFromTask` is byte-identical in both files — straightforward hoist. Keep the error-message return (visible-malformed-body contract).
- Cron normalisation differs by **output shape**: `commands.ts` returns `CronJobSummary` (id/name/enabled/schedule), `routes.ts` returns the richer `SourceStatus` (adds source/status/last_*). Extract the **common core** (candidate extraction `cronJobCandidates`, `inferCronEnabled`, `sourceFromJobName`) into `cronNormalise.ts`; each caller keeps its own shape-builder on top.
- `toSourceStatus` at `routes.ts:433-435` is a no-op identity wrapper — inline it (`.map(normaliseCronJob)` directly drops the wrapper) and delete it as part of this task.

**Step 1:** Write `tests/unit/cron-normalise.test.ts` covering: array input, `{jobs:[...]}` envelope, string job → enabled default, `paused:true` → disabled, `status:'disabled'` → disabled, `keryx-` prefix strip. Run → FAIL.

**Step 2:** Implement `src/hermes/cronNormalise.ts`:

```ts
import { firstString, isPlainObject } from '../util/object';

export function cronJobCandidates(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (!isPlainObject(value)) return [];
  for (const key of ['jobs', 'cron_jobs', 'items', 'results']) {
    if (Array.isArray(value[key])) return value[key];
  }
  return Object.values(value).flatMap((entry) => (Array.isArray(entry) ? entry : []));
}

export function inferCronEnabled(value: Record<string, unknown>): boolean {
  if (typeof value.enabled === 'boolean') return value.enabled;
  if (typeof value.paused === 'boolean') return !value.paused;
  const status = firstString(value.status, value.state);
  if (status) return !['paused', 'disabled', 'stopped'].includes(status.toLowerCase());
  return true;
}

export function sourceFromJobName(name: string): string {
  return name.startsWith('keryx-') ? name.slice('keryx-'.length) : name;
}
```

**Step 3:** Implement `src/hermes/taskBody.ts` with `parseActionItemFromTask`, `taskStatus`, `stringOrNull` (move verbatim from `routes.ts`; import `validateActionItem`/`formatValidationErrors`).

**Step 4:** Rewire both callers to import the core; keep their shape-specific `normaliseCronJob`/`CronJobSummary` vs `SourceStatus` builders local. Delete `toSourceStatus`. Run `npm run typecheck && npm run lint && npm test` after each file.

**Step 5: Commit**

```bash
git commit -am "refactor: share task-body parser and cron-normalisation core across opsctl/server"
```

---

## Task 1.4: Collapse the 8 `validate-*` commands into a table-driven helper

**Objective:** Replace 8 near-identical 12-line command functions (`src/opsctl/commands.ts:325-417`) with one helper + a descriptor table. **Output must stay byte-for-byte identical.**

**Files:** Modify `src/opsctl/commands.ts:325-417` (and the dispatch cases `189-202`).

**Care:** Each command emits distinct strings:
- missing arg: `FAIL validate-<cmd> requires a JSON file path` (exit 2)
- invalid: `FAIL invalid <noun>: <path>\n<errors>`
- success: `OK valid <noun>: <echoedField>`

The `<noun>` and `<echoedField>` differ per command. The table must reproduce these exactly. Integration tests in `tests/integration` assert these — they are the safety net.

**Step 1:** Read the current 8 functions and tabulate the exact `(commandName, validator, noun, successField)` tuples. For example:

```ts
interface ValidateSpec {
  command: string;          // 'validate-card'
  validator: (input: unknown) => { ok: true; value: any } | { ok: false; errors: ValidationError[] };
  noun: string;             // 'action card'
  success: (value: any) => string; // (v) => v.title
}
```

| command | noun | success field |
|---|---|---|
| validate-card | `action card` | `value.title` |
| validate-decision | `execution decision` | `value.selected_option_id` |
| validate-state | `collector state` | `value.source` |
| validate-policy-decision | `policy decision` | `value.disposition` |
| validate-outcome | `outcome` | `value.executed_option_id` |
| validate-policy | `policy` | `value.collector` |
| validate-dismissal | `dismissal decision` | `value.dismissed_external_id` |

> Note `validate-card` uses `parseJsonFile` then validates; the others vary slightly (some inline `parseJsonFile(...)` into the validator call). Normalise all to: `runValidate(filePath, spec)` → `parseJsonFile` → `spec.validator` → fail/ok. Confirm `validate-card`'s message is `FAIL invalid action card:` (not `action item`) against the test fixtures.

**Step 2:** Implement `runValidate(filePath, spec)` reproducing the three message shapes exactly, then replace each function body with a one-liner `return runValidate(filePath, SPEC.card)` etc.

**Step 3:** Run the **full** integration suite: `npm test`. This is the critical gate — if any verbatim string drifted, it fails here. Expected: all green.

**Step 4: Commit**

```bash
git commit -am "refactor: collapse 8 validate-* commands into table-driven helper"
```

---

## Task 1.5: Bound subprocess fan-out in `listTasksWithComments`

**Objective:** Replace the unbounded `Promise.all` over every card (`src/hermes/adapter.ts:51-59`) with a bounded-concurrency pool so a large board cannot spawn N simultaneous `hermes kanban show` subprocesses. **Output order must stay deterministic** (callers and tests rely on task order).

**Files:** Modify `src/hermes/adapter.ts:51-59`. Optionally add `src/util/concurrency.ts`. Test: `tests/unit/adapter-concurrency.test.ts` (use a fake runner that records max in-flight count).

**Step 1: Write failing test** — fake `HermesRunner` that increments a counter on entry, decrements on exit, and records the peak. Build a board of 25 tasks; assert peak in-flight ≤ the cap (e.g. 8) and that returned tasks keep input order.

**Step 2:** Implement an order-preserving bounded map:

```ts
// src/util/concurrency.ts
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}
```

Rewire `listTasksWithComments`:

```ts
async listTasksWithComments(options: ListTaskOptions = {}): Promise<KanbanTask[]> {
  const tasks = await this.listTasks(options);
  return mapWithConcurrency(tasks, 8, async (task) => {
    const shown = await this.showTask(task.id);
    return { ...task, comments: shown.comments ?? [] };
  });
}
```

**Step 3:** Run new test + `npm test` (the digest/metrics/track-record integration tests exercise this path and assert ordering). Expected: PASS.

**Step 4: Commit**

```bash
git commit -am "perf: bound listTasksWithComments subprocess fan-out (cap 8, order-preserving)"
```

---

## Task 1.6: Add timeout + cleanup to the default Hermes runner

**Objective:** A hung `hermes` CLI must not leave a promise pending forever and hang a Fastify request. Add a kill-on-timeout path to `defaultHermesRunner` (`src/hermes/adapter.ts:518-541`).

**Files:** Modify `src/hermes/adapter.ts:518-541`. Test: `tests/unit/hermes-runner-timeout.test.ts` (spawn a `node -e "setTimeout(()=>{}, 60000)"` style child or a sleep, assert it rejects within the timeout window).

**Care:** Default timeout should be generous (e.g. 30s) and overridable via config so legitimately slow calls aren't cut. Confirm whether `KeryxConfig` already carries a timeout; if not, thread one through `HermesRunRequest` with a default. On timeout: `child.kill('SIGTERM')`, then reject with a clear `Error`. Clean up listeners / clear the timer on `close` and `error`.

**Step 1: Write failing test** — runner against a command that sleeps longer than a short test timeout (e.g. 200ms); assert the returned promise rejects with a timeout message and the child is killed.

**Step 2:** Implement:

```ts
export async function defaultHermesRunner(request: HermesRunRequest): Promise<HermesRunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(request.bin, request.args, {
      env: { ...process.env, ...dropUndefined(request.env) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let settled = false;
    const timeoutMs = request.timeoutMs ?? 30_000;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGTERM');
      reject(new Error(`hermes call timed out after ${timeoutMs}ms: ${request.args.join(' ')}`));
    }, timeoutMs);

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.on('error', (error) => finish(() => reject(error)));
    child.on('close', (code) => finish(() => resolve({ stdout, stderr, exitCode: code ?? 1 })));
  });
}
```

Add `timeoutMs?: number` to `HermesRunRequest` in `src/hermes/types.ts`.

**Step 3:** Run new test + `npm test`. Expected: PASS. The fake runner in tests is unaffected (only `defaultHermesRunner` changes).

**Step 4: Commit**

```bash
git commit -am "fix: add timeout and listener cleanup to default Hermes runner"
```

---

# TIER 2 — Structural (higher effort, careful)

> Do Tier 1 first; several Tier 2 tasks build on the shared modules created above.

## Task 2.1: Extract the hand-rolled YAML reader

**Objective:** Move the ~100-line YAML-subset parser (`src/opsctl/commands.ts:1891-1991`: `extractTopLevelBlock`, `extractStringList`, `parseFlowList`, `unquote`, `stripInlineComment`, `leadingSpaces`) into its own module. It is independently testable and unrelated to command dispatch.

**Files:** Create `src/opsctl/yamlConfig.ts`; move the functions; update imports in `commands.ts` (doctor's `checkKanbanDefaultAssignee` consumes it). Create `tests/unit/yaml-config.test.ts` if not already covered.

**Verification:** `npm run lint && npm test`. Pure move — no behaviour change. Commit: `refactor: extract YAML-subset reader to opsctl/yamlConfig.ts`.

## Task 2.2: Split `commands.ts` along command-group seams

**Objective:** Break the 2,163-line god file into a thin router + command-group files. Mechanical but touches every command — do it as one focused PR after Tier 1, **one group at a time, lint+test between each move**.

**Target layout:**
- `src/opsctl/commands.ts` → thin dispatcher only: `runOpsctl`, `parseArgs`, `getHelpText`, `HELP_TEXT`, flag helpers, the uniform context type. Re-exports `buildOutcome`/`OutcomeInput` if tests import them from here (check `tests/` imports before moving).
- `src/opsctl/commands/validate.ts` — the table-driven validate-* (from Task 1.4) + `schema` + `template-card`.
- `src/opsctl/commands/cards.ts` — `createCard`, `autoExecute`, `createInterruptCard`, `resolveDisposition`, `deriveBandForClass`, policy-decision builders.
- `src/opsctl/commands/lifecycle.ts` — `executeCard`, `dismissCard`, `markReviewedCard`, decision/dismissal builders.
- `src/opsctl/commands/undo.ts` — `undoCard`, `findExecutedOptionId`, the 3 undo card builders.
- `src/opsctl/commands/policy.ts` — `policyCommand`, `policyShow`, `policyValidate`, `policyPropose`, `policyRevoke`, proposal/revocation card builders.
- `src/opsctl/commands/metricsCmd.ts` / `digestCmd.ts` / `defaultResolveCmd.ts` / `regretCmd.ts` — the remaining handlers.
- `src/opsctl/doctor.ts` — `doctor`, `checkHermesVersion`, `compareSemver`, `findExecutable`, plugin/bundle/assignee checks, `MINIMUM_HERMES_VERSION`, `COLLECTOR_CREATOR_*` constants, `PROJECT_ROOT`/`resolveProjectRoot`.

**Per-group procedure:**
1. Create the new file, move the functions + their private helpers, add named exports.
2. Import them back into `commands.ts` for the dispatch switch.
3. `npm run lint && npm test` (and `npm run typecheck`).
4. Commit: `refactor: split opsctl <group> commands into own module`.

**Pitfalls:**
- Check `tests/` for direct imports from `commands.ts` (e.g. `buildOutcome`, `getHelpText`) before moving — keep those exports stable or re-export.
- Move private helpers **with** their only consumer; if shared by two groups, put them in a `src/opsctl/shared.ts`.
- Do **not** change function signatures in this task — pure relocation. Signature unification is Task 2.3.

## Task 2.3: Unify command-handler signatures with a context object

**Objective:** Resolve `now` once and pass a uniform `{ parsed, adapter, config, now, options }` context to every handler, eliminating the 7× repeated `options.now ?? (() => new Date())` and the inconsistent arg shapes.

**Files:** `src/opsctl/commands.ts` (`runOpsctl` + dispatch) and each command-group file.

**Approach:**
```ts
interface CommandContext {
  parsed: ParsedArgs;
  adapter: HermesCliAdapter;
  config: KeryxConfig;
  now: () => Date;
  options: RunOpsctlOptions;
}
```
Build it once in `runOpsctl`, pass to every handler. Update each handler to read from `ctx`. Verification: `npm run lint && npm test && npm run typecheck`. This is CAREFUL — it touches every handler signature; rely on the integration suite. Commit: `refactor: pass uniform command context to opsctl handlers`.

## Task 2.4: Consolidate near-duplicate decision/policy builders

**Objective:** Collapse paired builders that differ only in actor/disposition.

**Pairs (all in the moved command-group files now):**
- `buildExecutionDecision` + `buildAutoResolutionDecision` → one builder taking `{ selectedOptionId, userFeedback, approvedBy, approvedVia, now }`.
- `buildDismissalDecision` + `buildAutoResolutionDismissal` → one builder taking `{ actionItem, reason, dismissedBy, dismissedVia, now }`.
- `buildPolicyDecision` + `buildShadowPolicyDecision` → one builder taking `{ ..., shadow: boolean }` controlling `disposition` ('silent' vs 'review') and the `approved_via` prefix.

**Care:** These emit `keryx.*.v1` schema strings (contracts) and feed JSON validated by ajv — keep field names/values byte-identical. Unit tests assert decision shapes. Verification: `npm test`. Commit per pair: `refactor: parameterise <x> decision builders`.

## Task 2.5: Extract `handleMutation` wrapper for the 5 mutating routes

**Objective:** Remove the repeated preamble (no-store headers, `validateTaskId`, request-body object check, optional-field validation, argv build, `runOpsctl`, `sendCommandResult`) across the 5 mutating handlers in `src/server/routes.ts:116-231`.

**Approach:** A `handleMutation(reply, id, buildArgv)` helper centralises the common path; each route keeps only its per-route field validation and argv assembly. Verification: `npm run typecheck && npm test && npm run e2e` (visible inbox mutations). Commit: `refactor: extract shared mutation handler in server routes`.

## Task 2.6: Define the API wire contract once

**Objective:** `ApiTask`, `SourceStatus`, `MalformedTaskError` are declared in **both** `src/server/routes.ts:31-62` and `src/web/lib/api.ts:11-50`. Define them once so server and web cannot drift.

**Approach:** Create `src/shared/apiContract.ts` (importable by both Node server and Vite web bundle — verify it contains only types, no runtime Node imports, so the web bundle stays clean). Import from both sides. Verification: `npm run typecheck && npm run build && npm test`. Commit: `refactor: share API wire-contract types between server and web`.

---

# TIER 3 — Targeted efficiency & silent-failure fixes

## Task 3.1: Select the validator by `schema` discriminator in read-side scans

**Objective:** `src/policy/metrics.ts:131-175` and `src/policy/trackRecord.ts:57-76` run up to 5 ajv validators (each with its cross-validators) per comment. Dispatch on the body's existing `schema` field to pick the one validator, falling back to the scan only when the field is absent.

**Files:** `src/policy/metrics.ts`, `src/policy/trackRecord.ts`. Possibly a small `src/schemas/validatorBySchema.ts` map `{ 'keryx.outcome.v1': validateOutcome, ... }`.

**Care:** SAFE only if the fallback preserves current behaviour for bodies lacking `schema`. Keep the malformed-body-visible contract (these scans already skip non-matching bodies by design). Verification: `npm test` (metrics/track-record unit + integration assert exact counts/bands). Commit: `perf: dispatch read-side comment validation by schema discriminator`.

## Task 3.2: Parallelise the independent doctor reads

**Objective:** `doctor` (`src/opsctl/commands.ts:1667-1705`, after split → `doctor.ts`) awaits 4 independent Hermes reads sequentially (blocked tasks, delivery targets, cron jobs, plus version). Run them with `Promise.allSettled` and emit `DoctorLine`s in the **same fixed order**.

**Care:** Output text and which lines appear must not change — only timing. Each read keeps its own try/catch → WARN/FAIL line. Verification: `npm test` (doctor integration asserts line order/text). Commit: `perf: run independent doctor reads concurrently`.

## Task 3.3: Fix `sendStaticFile` silent-failure + TOCTOU

**Objective:** `src/server/app.ts:85-101` does `access()+stat()+readFile()` (TOCTOU) and a bare `catch {}` that collapses **all** errors — including permission/IO faults — into a 404, hiding misconfiguration.

**Approach:** Drop `access()`; call `readFile()` directly; map only `ENOENT`/`EISDIR` to 404; log/surface other errors (e.g. 500 + server log) so misconfig is visible. **Keep** the `isPathInsideRoot` containment check (security boundary). Verification: `npm test` (static-serving integration) + `npm run e2e`. Commit: `fix: stop swallowing non-404 errors in static file serving`.

## Task 3.4: Distinguish read errors from JSON errors in `loadPolicy`

**Objective:** `src/policy/policyStore.ts:70-91` uses `existsSync()`-then-`readFileSync()` (TOCTOU) and mislabels a read-permission failure as `policy file is not valid JSON`.

**Approach:** `readFileSync` directly inside try; treat `ENOENT` as the absent-file (empty policy) case; report other read errors with a distinct message from JSON-parse errors. Verification: `npm test` (policy-store unit). Commit: `fix: distinguish policy read errors from JSON parse errors`.

## Task 3.5: Micro-optimisations (batch into one commit)

- `src/opsctl/digest.ts:83-89` — `compareCategories` calls `order.indexOf()` twice per comparison (O(n²·m)). Precompute a `Map<category, index>` once before sorting.
- `src/opsctl/commands.ts:168` — `PROJECT_ROOT` runs `resolveProjectRoot` at module load (sync dir walk + `readFileSync`/`JSON.parse` per `package.json`), blocking first import incl. server startup. Make it lazy (compute on first doctor use). After Task 2.2 this lives in `doctor.ts`.
- `src/opsctl/commands.ts:278-281` — `schemaCommand` re-reads + round-trips JSON on every call; low impact, optional cache.

Verification: `npm test`. Commit: `perf: small digest/startup/schema-command optimisations`.

---

# TIER 4 — Web / UI

## Task 4.1: Consolidate in-flight per-task state

**Objective:** `src/web/App.svelte` tracks "action in flight for task X" across `regretPendingByTask` (line 65), `reviewLogPendingByTask` (66), and `revokingRuleId` (58), alongside the already-typed `pendingByTask` (52). `feedbackByTask` (51) is **input text, not in-flight** — leave it separate.

**Approach:** Fold the three in-flight trackers into the existing `pendingByTask: Record<string, PendingAction | undefined>` by extending `PendingAction` to carry the kind (`'execute' | 'regret-acted' | 'regret-asked' | 'review-undo' | 'review-archive'`). For policy-rule revocation, key by rule id within the same map or a dedicated narrow field if rule ids and task ids can collide. Update the 3 handlers' set/clear sites.

**Care:** This is reactive Svelte state — verify the `disabled`/spinner bindings still react. Verification: `npm run typecheck && npm run e2e`. Commit: `refactor: consolidate per-task in-flight state in inbox`.

## Task 4.2: Call `optionNeedsFeedback` from the button binding

**Objective:** `App.svelte:106-107` defines `optionNeedsFeedback`, but the button `disabled` expression at ~line 513 re-inlines the same `option.requires_input && feedback empty` logic. Call the helper.

**Verification:** `npm run typecheck && npm run e2e`. Commit: `refactor: reuse optionNeedsFeedback in disabled binding`.

## Task 4.3: Hoist repeated `undoLabelFor(task)` in the done-card template

**Objective:** `undoLabelFor(task)` is called 3× per done card (`App.svelte:277-285,453,464`). Hoist to a `const undoLabel = undoLabelFor(task)` within the `{#each}` block.

**Verification:** `npm run typecheck && npm run e2e`. Commit: `refactor: compute undo label once per done card`.

## Task 4.4: Derive the polling label from `pollIntervalMs()`

**Objective:** `App.svelte:335` hard-codes "Polling every 30s" while the interval comes from `pollIntervalMs()` (overridable). If overridden, the UI lies. Derive the label: `Polling every ${Math.round(pollIntervalMs() / 1000)}s`.

**Care:** Low priority; confirm no e2e test asserts the literal "30s" string before changing (if it does, update the test in the same commit). Verification: `npm run typecheck && npm run e2e`. Commit: `fix: derive polling-interval label from actual interval`.

---

## Suggested execution order & batching

1. **Tier 1** (1.1 → 1.6) — highest risk-adjusted value; lands the shared modules others build on.
2. **Tier 3** (3.1 → 3.5) — quick, mostly SAFE, independent of the split.
3. **Tier 2** (2.1 → 2.6) — the structural split; do as its own focused sequence, group-by-group, since it touches every command.
4. **Tier 4** (4.1 → 4.4) — UI; needs `npm run e2e` green.

## Global validation gates

- Per task: `npm run lint && npm test` minimum.
- Touching Svelte/shared types: add `npm run typecheck`.
- Touching entrypoints/bundling/shared contract module: add `npm run build`.
- Touching visible inbox behaviour (Tier 4, Task 2.5): add `npm run e2e`.
- Final, before merge: full `npm run lint && npm run typecheck && npm test && npm run build && npm run e2e` and `hermes keryx doctor` (or `./bin/opsctl doctor`).

## Risks & open questions

- **`firstString` trim divergence (Task 1.1)** — the one genuine behaviour decision. If any adapter caller relies on untrimmed values, defer that consolidation to OUT_OF_SCOPE and keep adapter's local copy.
- **Verbatim CLI output (Tasks 1.4, 2.x, 3.2)** — the integration suite is the safety net; never hand-edit an expected string to make a refactor pass.
- **`commands.ts` split (Task 2.2)** — check test imports from `commands.ts` before moving exports; keep re-exports where tests depend on them.
- **Out of scope by design:** everything in `OUT_OF_SCOPE.md` (this directory) — the `firstString`/`createdTaskId` semantic-divergence merges, the `build*Card` scaffold factory, status-constant introduction, and all `disposition.ts` changes.
