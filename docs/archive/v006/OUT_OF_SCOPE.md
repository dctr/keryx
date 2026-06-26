# v006 — Deliberately Dropped / Flagged (Out of Scope)

These findings came out of the v006 simplification review but are **intentionally
excluded** from `PLAN.md`. Each is here because it carries a real behaviour-change
risk, breaks a contract, or is cosmetic in safety-critical code. Revisit
individually — none is a mechanical refactor, and each needs a decision before it
can be done safely.

---

## 1. `firstString` trim-semantics divergence (decide, don't assume)

- **Where:** `src/hermes/adapter.ts:506-508` (no trim) vs `src/server/routes.ts:481-483` (trims via `?.trim()`). A third copy in `commands.ts:2157-2159` (no trim).
- **Why flagged:** PLAN Task 1.1 consolidates these into `src/util/object.ts` adopting the **trimming** version as canonical. That is a behaviour change for the adapter callers. If any adapter consumer needs the untrimmed value, the consolidation must keep adapter's local copy instead.
- **Action when revisited:** audit every adapter `firstString` call site; if all only compare/emit the value, the trimming merge is safe (folded into Task 1.1). If even one depends on untrimmed output, leave adapter's copy and document why.
- **Risk:** RISKY (semantics). **Confidence the dup exists:** high.

## 2. `createdTaskId` vs `extractCreatedTaskId` divergence

- **Where:** `src/opsctl/commands.ts:505-513` (`createdTaskId`: checks only `id`, returns `null` on miss) vs `src/hermes/adapter.ts:280-290` (`extractCreatedTaskId`: checks `id` **and** `task_id`, **throws** on miss).
- **Why flagged:** They look like duplicates but behave differently on both the key set and the failure mode. A naive merge changes which envelopes are accepted and whether a miss is null vs throw — both observable.
- **Action when revisited:** decide the canonical envelope key set and failure contract, then converge both call sites deliberately (likely export one extractor with a `throwOnMissing` flag).
- **Risk:** RISKY. **Confidence:** medium.

## 3. `build{Reversal,Correction,Corrective}Card` + policy-card scaffold factory

- **Where:** `src/opsctl/commands.ts:1207-1341` (3 undo card builders), `1496-1633` (policy proposal/revocation cards), `285-323` (`templateCard`). All share a large invariant `keryx.action_item.v2` scaffold.
- **Why flagged:** Extracting a `baseActionItem()` factory is tempting, but card **titles, summaries, option labels, and execution/undo prompts are asserted verbatim by tests** and are user-facing text. A factory that touches anything beyond the structural invariant fields (`schema`, `source`, `collector`, `source_refs` shape, `urgency`, `proposed_disposition`, `deadline`, `created_at`, `ui.display_group`) risks silently altering that text.
- **Action when revisited:** if done at all, limit the factory strictly to the structural invariant fields and pass **all** human-readable text as per-card overrides; gate on the full card-builder unit/integration tests.
- **Risk:** RISKY. **Confidence:** medium.

## 4. Status-constant introduction (`ready`/`running`/`done`/`blocked`/`todo`/`archived`)

- **Where:** raw status literals scattered across `executeCard`/`dismissCard`/`markReviewedCard` (`src/opsctl/commands.ts:~716-732`) and the web `viewOptions`.
- **Why flagged:** A `KanbanStatus` union exists in `src/hermes/types.ts`, but introducing named status **sets** (e.g. `TERMINAL`, `ACTIONABLE`) and rewiring call sites can subtly change which statuses a command accepts/transitions. Several of these strings also appear in test assertions.
- **Action when revisited:** map every literal's current set membership first, prove the named sets reproduce it exactly, then migrate with the status-transition tests as the gate.
- **Risk:** RISKY. **Confidence:** medium.

## 5. `disposition.ts` cosmetic findings — explicitly NOT doing

- **Where:** `src/policy/disposition.ts:153-165` (early `interruptRule` match before time-pressured branches) and `:187` (`{ ...review(...), shadow: true, rule_id }` spread).
- **Why flagged:** Both reviewers noted these as cosmetic, then concluded *leave as-is*. This is safety-critical decision-order code; the early rule match is intentional for attributing `rule_id`. An optional `shadowReview()` factory for symmetry is the only conceivable change and is not worth the risk.
- **Action when revisited:** do not change decision order or thresholds under any "simplification" banner. Any edit here needs its own PRD-level justification and the full disposition test matrix.
- **Risk:** RISKY. **Confidence:** low (that any change is warranted).

## 6. `ApiTask` redundant `source` vs `tenant` (and `SourceStatus` field overlap)

- **Where:** `src/server/routes.ts:31-62`. `ApiTask` emits both `source` (from `action_item.source`) and `tenant` (from `task.tenant`); `SourceStatus` duplicates `name`/`source`/`state`/`last_status`.
- **Why flagged:** Possibly derivable redundancy, but the web layer may legitimately need both fields, and narrowing the wire type could break `src/web/lib/taskView.ts` consumers. (Note: PLAN Task 2.6 *shares* these types across server/web — it does **not** trim fields. Field-trimming is the out-of-scope part.)
- **Action when revisited:** confirm against the Svelte consumers whether `source` is always derivable from `tenant` (or vice versa); only then derive one in `taskView.ts` and narrow the contract.
- **Risk:** RISKY. **Confidence:** low.

## 7. `isAllowedKanbanCreateRest` positional allowlist coupling

- **Where:** `src/hermes/adapter.ts:262-278` — hard-codes `rest.length === 12` and index-by-index flag string comparisons that mirror `createCardArgs`.
- **Why flagged:** Driving both the builder and the guard from one ordered flag spec would prevent desync, but the guard is a **security allowlist** on what reaches `hermes kanban create`. Refactoring it risks widening or narrowing the allowed argv surface. Must be done with extreme care and full adapter security tests.
- **Action when revisited:** introduce a single ordered flag spec, derive both `createCardArgs` and the guard from it, and prove the accepted argv set is byte-identical before/after.
- **Risk:** RISKY (security boundary). **Confidence:** medium.

## 8. `sendCommandResult` JSON-parse fallback tightening

- **Where:** `src/server/routes.ts:306-310` — `catch {}` on `JSON.parse` wraps non-JSON opsctl stdout as `{ ok: true, output }`.
- **Why flagged:** Benign for text commands (they rely on it), but it would mask a malformed-JSON response from a `--json` command as success. Tightening means only falling back when the command did **not** request `--json` — which requires threading that knowledge into the handler.
- **Action when revisited:** pass the `--json` intent into `sendCommandResult`; only text-mode commands get the raw-output fallback.
- **Risk:** CAREFUL. **Confidence:** low.

## 9. `as unknown as KanbanTask` double-cast

- **Where:** `src/hermes/adapter.ts:495`.
- **Why flagged:** The double-cast bypasses the type system after only checking `id` is a string. Either narrow with a proper type guard validating the optional downstream fields, or accept `KanbanTask` as a loose index-signature type and cast once. Low urgency; not a correctness bug today.
- **Action when revisited:** prefer a real type guard if downstream code reads fields beyond `id`.
- **Risk:** CAREFUL. **Confidence:** medium.

## 10. `selectedOptionFor` vs `primaryOptionFor` (cross-bundle)

- **Where:** `src/opsctl/commands.ts:579-582` (`selectedOptionFor`, falls back to `options[0]`) vs `src/web/lib/taskView.ts:184-187` (`primaryOptionFor`, falls back to `?? null`).
- **Why flagged:** Near-duplicate, but they live in **separate build targets** (Node CLI vs web bundle) and differ in the null fallback. Sharing requires a common module both bundles can import without dragging Node-only deps into the browser. Only worth it if such a shared module already exists post-refactor.
- **Action when revisited:** if a clean cross-target `shared/` module lands (cf. PLAN 2.6), reconcile the fallback semantics and share; otherwise leave.
- **Risk:** CAREFUL. **Confidence:** low.

## 11. Top-level `FAIL` token contract audit

- **Where:** `src/opsctl/commands.ts:238-240` top-level catch prefixes `FAIL ${msg}`, while inner commands already return `fail('FAIL ...')` and adapter errors lack the prefix.
- **Why flagged:** There may be paths that produce double-`FAIL` or zero-`FAIL` tokens. Tests assert exactly one leading `FAIL`. This is an audit-and-document task, not a quick edit, and touching it risks breaking the asserted output contract.
- **Action when revisited:** enumerate every error path, assert exactly one leading `FAIL`, and document the contract on `fail()`.
- **Risk:** RISKY (output contract). **Confidence:** low.

---

### Note on the absolute floor / disposition

Nothing in this list — or in `PLAN.md` — touches the absolute-floor rule
(money/destructive/credential_gate options can never run silently) or the
disposition decision order. Those are deliberately frozen for v006.
