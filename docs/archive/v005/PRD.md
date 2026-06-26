# Keryx v005 Product Requirements Document: Attention-Allocation Surface

**Date:** 2026-06-25
**Project path:** repository root (`.`)
**Status:** Planning specification only. This document describes the product and architecture work required to evolve Keryx from a single-queue approval inbox into a layered attention-allocation system, as motivated by `docs/archive/v005/BOTTLENECK.md`. It is not an implementation record.

---

## 1. Summary

Keryx today is a thin control surface over Hermes Kanban with one operating mode: **collectors create `blocked` cards, a human reviews every card in a polling dashboard, and approval is the only thing that authorizes a side effect.** This is a faithful implementation of "prepare for review" — one of the four queues described in `BOTTLENECK.md` §9 — but it is the *only* queue Keryx implements.

`BOTTLENECK.md` argues that the central constraint for a high-value personal assistant is not task execution but **selective escalation**: knowing when to act silently, when to batch, when to interrupt, and how to interrupt without making the human the integration layer. A system that funnels everything through one review queue and a polling dashboard recreates the attention bottleneck it was meant to remove (§7, §12.7).

v005 evolves Keryx into an **attention-allocation surface**. It implements three *dispositions* for any candidate action — **do silently, prepare for review, interrupt now** — plus a non-urgent **result-delivery** channel (the daily/weekly **digest**) that reports the outcomes of what Keryx did silently. Throughout, Keryx's defining constraints are preserved: Hermes Kanban remains the single source of truth, the Hermes adapter stays allowlisted, source content stays untrusted, and there is no second task database.

> **Why three dispositions, not four.** `BOTTLENECK.md` §9 lists "batch later" as a fourth *queue of deferred decisions*. In Keryx that queue is redundant: the user already has a web dashboard and can sweep low-urgency review items on their own schedule (start/end of workday). The user does not want to be *handed* a batch of decisions to make. What the user does want batched is the **non-urgent reporting of work Keryx performed autonomously** — newsletter monitors, sales/event/weather watchers, routine maintenance like unsubscribes and forwarding rules. So "batch" in Keryx is not a disposition; it is the **digest of silent outcomes**, and the dashboard is the pull-surface for decisions. See §5 and §7.6.

The organizing idea of v005 is **confidence-graduated autonomy**. A class of action does not get a fixed autonomy level; it *climbs a ladder* as Keryx accumulates a track record of the user approving its proposals:

- **Cold** (no track record): create a card, do no pre-work, ask for a decision.
- **Warming** (some track record): do the reversible prep — draft the reply, stage the calendar hold — and offer *approve & send*.
- **Trusted** (strong track record + the user has approved a promotion): act autonomously for that specific class and report the outcome in the digest.

How fast a class is *allowed* to climb is governed not by its domain but by two bounded, domain-independent risk axes — **reversibility** and **blast radius** — plus the **confidence** derived from the user's own approval history. This replaces the original single `autonomy` enum, which could neither span unforeseen domains nor separate "reversible thing in my own space" from "real-world action affecting others."

This PRD covers:

1. A redesigned autonomy model (`action_item.v2`) that classifies each option by **risk** (`reversibility`, `blast_radius`), derives **confidence** from track record, and lets a deterministic policy function assign a disposition.
2. A **silent execution path** for actions a class has graduated into, plus **`read_only` monitor** outputs that are silent by design, both restricted by the risk axes and an absolute floor.
3. A **result-delivery channel** — silent outcomes are recorded and reported in a **daily/weekly digest categorized by relevancy** (modeled on the user's existing `daily-brief`/`weekly-brief`), with a `push` escape hatch when the *result itself* is time-sensitive.
4. **Honest undo / reversibility** semantics so autonomously executed work can be reviewed, archived, or reversed/corrected.
5. **Interrupt-now escalation** — Keryx calls `hermes send` directly (D2=A) — with an escalation ladder, expiring defaults, and rate limiting that prevents notification creep.
6. A **human-approved, schema-bounded policy store** (`keryx.policy.v1`) whose uniform rule shape spans an unbounded task space via an open `class` key.
7. **Separation of judgment from execution**: a deterministic disposition function plus an optional monitor agent for the genuinely ambiguous case.
8. **Attention-economics metrics** derived from Kanban state and decision/dismissal comments.

The unifying principle: **the human approval comment is no longer the only trust gate.** When Keryx acts silently, the trust gate becomes an explicit, inspectable, human-approved policy rule — never a claim made by a collector or by untrusted source content, and never reachable for money, destructive, or credential-gated actions. Section 11 treats this as the central security problem of v005.

---

## 2. Background and motivation

### 2.1 The bottleneck thesis

`BOTTLENECK.md` synthesizes HCI theory (mixed-initiative computing, adjustable autonomy), recent agent benchmarks (HiL-Bench's "judgment gap," "Ask or Assume?"'s monitor/executor separation, CHI-2026 intermediate-confirmation work), and practitioner reports into one design doctrine:

> Interrupt when the expected cost of not interrupting exceeds the expected cost of interrupting, after accounting for reversibility, urgency, confidence, policy coverage, and the user's current attention state. (§13)

It prescribes four queues (§9), an escalation ladder (§10.5), reversible-first action (§10.2), evidence packs (§10.3), expiring defaults (§10.6), policy learning from corrections (§10.7), judgment/execution separation (§10.8), and attention-economics metrics (§11). v005 maps each of these onto Keryx primitives, collapsing the fourth queue into the digest (§1).

### 2.2 What Keryx does today (verified current state)

- **Lifecycle:** collector → `create-card` (always `blocked`) → human review in web inbox → `execute` (appends a trusted `keryx.execution_decision.v1` comment, promotes card to `ready`) → Hermes dispatch → worker runs the selected option → `done`; or `dismiss` (appends a `keryx.dismissal_decision.v1` comment, archives the card).
- **`action_item.v1`** carries `autonomy: [auto, minimal, research, complex]` and `urgency: [low, normal, soon, urgent]`, compact `source_refs`, and one or more executable `options` each with an `execution_prompt`.
- **Adapter allowlist** (`src/hermes/adapter.ts`): `kanban list/show/create/block/assign/promote/comment/archive/dispatch`, `send --list` (enumerate targets only), `cron list --all`, and `--version`. **There is no send capability.**
- **Web UI** (`src/web/`) is a 30-second-polling dashboard with four lanes derived from status: Inbox (`blocked`,`todo`), Running (`ready`,`running`), Completed (`done`), Dismissed (`archived`).
- **Worker** already has a *feedback-to-automation loop*: free-text `user_feedback` that generalizes into a repeatable preference is turned into a **new blocked suggestion card** proposing an edit to the source collector's `keryx-collector-$SOURCE` skill. Policy learning therefore already exists in embryonic, prose-based form and is already human-approved.
- **The user already runs autonomous, digest-style crons today.** The `daily-brief` and `weekly-brief` skills are scheduled jobs that gather information autonomously and deliver a single relevancy-grouped, omit-empty briefing. v005's digest generalizes exactly this pattern over Keryx silent outcomes.

### 2.3 The core gaps

1. **The silent lane was designed and never wired up.** `autonomy: "auto"` exists in the schema and the UI labels it "Auto," but `createTaskFromActionItem` hard-codes `create → block → assign` for every card.
2. **The single `autonomy` enum is the wrong abstraction.** It conflates *how risky an action is* with *how much work it is*, and it cannot span domains we cannot foresee. "Drafting an email" and "putting a hold in my calendar" are both reversible actions in the user's own space; "send the email," "send a calendar invite," and "spend money" have real-world impact. One enum cannot express that, and "observe" was never a valid card outcome — a card is always awaiting or being executed.
3. **The dashboard is the anti-pattern for *notifications*, but the right surface for *decisions*.** A user who must remember to open a board to *learn what happened* is still the bottleneck (§7, §12.7). But a user *choosing when to work through pending decisions* is exactly the control the dashboard should give. v005 splits these: push/digest reports outcomes; the dashboard is where the user pulls and works review items at will.
4. **There is no record of an autonomous outcome and no way to report it.** Silent execution needs a structured outcome the digest can read.
5. **Removing the human removes the trust gate.** Silent execution must replace the human approval comment with an explicit, inspectable policy gate whose **confidence comes from the user's own history**, not from a collector reasoning over untrusted content (Section 11).
6. **`dismissal_decision.v1` has no schema file and no validation command** — a contract gap that widens once dismissals feed policy learning and metrics.

---

## 3. Goals and non-goals

### 3.1 Product goals

- Implement the three attention dispositions — **silent, review, interrupt** — with disposition *derived* from risk + confidence, never declared by source content.
- Record every silent execution as a structured **outcome**, and report outcomes through a **relevancy-categorized daily/weekly digest**, with a `push` escape hatch for time-sensitive results.
- Make the **dashboard the pull-surface for pending decisions** (review items), so the user batch-attends them on their own schedule — no system-pushed queue of decisions to make.
- Classify actions by **bounded, domain-independent risk axes** (`reversibility`, `blast_radius`) so Keryx spans unforeseen domains without enumerating them.
- Derive **confidence from the user's approval track record**, and graduate a class from ask → draft+approve → autonomous only with explicit human-approved promotion.
- Treat **`read_only` monitor outputs as silent-by-design** (no state mutation, so no graduation rule required) and route them to the digest.
- Provide a **safe silent-execution path** with an absolute floor (money/destructive/credential = never silent) and shadow mode before any state-changing class goes live.
- Turn the completed lane into a **review log** with archive-after-read and an honest **undo / correct** path.
- Make **interrupt-now** a genuine push via `hermes send`, with an escalation ladder, expiring defaults, and rate limiting.
- Replace prose automations with a **uniform, schema-bounded, human-approved policy store** that scales to an unbounded task space via an open `class` key.
- Add **attention-economics metrics** (§11) derived from Kanban without a second store.

### 3.2 Architecture goals

- Preserve the thin-control-surface invariant: **no second task database; Hermes Kanban remains the central register.**
- Keep all Hermes command execution **allowlisted** in `src/hermes/adapter.ts`; the new `hermes send` capability is a single narrow, tested shape.
- Route silent execution, undo, and digest delivery through the **same centralized command logic** as `opsctl`/`hermes keryx`/the API.
- Keep **blocked-by-default as the fallback**: any card not provably qualifying for a less-cautious disposition is `blocked`.
- Keep **source content untrusted** and **no raw event persistence** intact through every new path, including policy, outcomes, and metrics.
- Keep the web server **local-only** by default; interrupt/digest delivery via the gateway does not open an inbound surface.

### 3.3 Non-goals

- Do not build a user-configured rules engine (§16 q6); rules are captured from corrections, proposed for approval, and kept small and legible.
- Do not allow silent execution of **money/payments, destructive data loss, or credential/2FA/CAPTCHA gates** under any card claim or learned rule.
- Do not push the user a queue of pending decisions; pending decisions live in the dashboard and the digest only *reports outcomes* (an optional one-line "N items await review" footer is opt-in, off by default — §16 q8).
- Do not add Keryx as a model tool, and do not add a generic Hermes passthrough.
- Do not expose the web server beyond localhost or add built-in auth.
- Do not create real collector cron jobs, mutate a real `keryx` board, or install into a real Hermes home in tests.
- Do not attempt true "unsend" of socially irreversible actions; undo is honest about what it can and cannot reverse.
- Do not model subjective interruption cost from sensors/biometrics; v005 uses coarse quiet-hours + tier budgets only (§16 q1).

---

## 4. Design principles (Keryx adaptation of `BOTTLENECK.md` §16)

1. **Attention is the scarce resource.** Every interrupt-tier push is charged against a daily budget; everything non-urgent goes to the digest.
2. **Classify by risk, not by domain.** Reversibility and blast radius are bounded and universal; the task space is not.
3. **Confidence is earned, not asserted.** It is derived from the user's approval history, so it cannot be inflated by a collector or by injection.
4. **Ask only decision-changing questions** with a precise default; "do you want me to handle this?" is not a valid interruption.
5. **Prefer reversible progress.** Silent execution is allowed only where reversibility and blast radius permit; otherwise draft/queue/hold.
6. **Escalate authority, not anxiety.** Interrupt when policy or authority is missing, not whenever the agent feels uncertain.
7. **Make interruptions self-contained.** Recommendation, evidence, risk, default-on-timeout, compact reply options.
8. **Report, don't poll.** Non-urgent outcomes arrive in a digest the user reads passively; decisions wait in a dashboard the user pulls on their own schedule. Real-time attention is reserved for urgency and consequence.
9. **Keep policy legible and revocable.** The user can always see what may run silently, what needs approval, and what is logged.
10. **Graduate with approval.** Every promotion up the autonomy ladder is a human decision the system proposes but never takes itself.
11. **Preserve agency in human domains.** Social/relationship, taste, identity, money, and learning default to draft/options, never silent commitment.
12. **Measure interruption quality**, not task count.

---

## 5. The attention-allocation model in Keryx

v005 implements three dispositions plus a result-delivery channel. The mapping onto Kanban status uses a derived **disposition** — no new database.

| Disposition | Meaning | Kanban realization | How the user learns / acts |
|---|---|---|---|
| **Silent** | Class has graduated, or the option is `read_only`. Acts without per-item approval. | Card created `ready` with a synthetic `policy_decision` comment; worker executes and writes a structured **outcome**; card lands in **review log**. | **Digest** (default) reports the outcome non-urgently; `push` only if the result itself is time-sensitive; `log_only` to pull from the review log. |
| **Review** (default) | Draft / gather / propose; do not commit. | Card created `blocked`; human approves an option. | **Dashboard** — the user pulls and works these on their own schedule (e.g. start/end of day, urgency-sorted). |
| **Interrupt** | Urgent and consequential, or blocked where delay/wrong action is costly. | Card created `blocked` and flagged interrupt; Keryx pushes a self-contained message with a deep link and expiring default. | **Push** via `hermes send` → dashboard. |

**The digest is not a disposition.** It is the **non-urgent delivery channel for silent outcomes**. Two kinds of silent task feed it, both categorized by relevancy:

- **Informational / monitor** (`read_only`) — Facebook-group posts, sales watchers, upcoming events, weather changes. The option mutates no state; it reads sources and produces an outcome message *for the user*. Because `read_only` + `self` exercises no authority, it is **silent by design and needs no graduation rule** (worst case is digest noise). This is the `daily-brief` pattern formalized.
- **State-changing action** (`reversible`/`compensable`) — a real side effect the class has graduated into (newsletter unsubscribe, an automated forwarding rule). Subject to the graduation ladder + policy rule, then reported in the digest like any silent outcome.

**Disposition is derived, not declared.** A collector supplies per-option risk evidence (`reversibility`, `blast_radius`) and an open `class` key; Keryx looks up the **confidence** (track record) for that `class` and runs the **disposition function** (§7.2) against the collector's approved policy. A card whose evidence does not clearly justify silent or interrupt falls back to **Review** and waits in the dashboard. Silent is never reachable for a state-changing class without an explicit, human-approved promotion, and never at all for the absolute-floor categories.

---

## 6. Decision record

These executive decisions were surfaced with options/pros/cons; the chosen option and rationale are recorded here so reviewers can challenge any of them by editing this document.

- **D1 — Autonomy model: risk axes + derived confidence (`action_item.v2`).** Drop the `action_class`/single-enum approach. Classify each option by two bounded, domain-independent axes — **`reversibility`** as an ordered commitment spectrum (`read_only`/`reversible`/`compensable`/`irreversible`) and **`blast_radius`** (`self`/`external`) — and derive **`confidence`** from the user's approval track record for an open, collector-defined **`class`** key. A deterministic disposition function combines these. *Rationale:* an action-type enum cannot span unforeseen domains; risk axes are bounded and universal; deriving confidence from history (not from a collector) removes an injection vector. `read_only` is the limit case of reversibility (mutates nothing), so monitor/FYI outputs fall out of the same axis instead of needing a separate `informational` flag. "observe" is dropped — it was never a card outcome.
- **D2 — Interrupt/digest delivery: Keryx calls `hermes send` directly (chosen: A).** Add a single narrow allowlisted `send` shape to the adapter; add a `notify_target` to `keryx.config.json`; add a setup-script step that lists delivery targets and stores the chosen default. Rate-limiting and quiet hours live in Keryx. *Rationale:* user-selected; simplest path that keeps escalation logic and audit inside Keryx.
- **D3 — Undo: per-option honest reversibility.** The executed option's `reversibility` governs: `reversible` → real undo; `compensable` → labeled correction (never a fake "unsend"); `irreversible` → no undo, only a corrective card.
- **D4 — "Batch later" is the digest of silent outcomes, not a decision queue (revised).** There is **no `batch` disposition, no `keryx:batch` tag, and no "Later" lane.** Silent executions record a structured outcome; a scheduled `keryx-digest` job reads outcomes since the last digest and reports them in one relevancy-categorized message (daily/weekly), modeled on `daily-brief`/`weekly-brief`. Pending *decisions* are not pushed — they wait in the dashboard, which the user sweeps on their own schedule via the urgency filter. *Rationale:* user feedback — "I don't need a briefing about a batch of items to approve; the dashboard already lets me decide when to attend low-urgency items. Batch should be FYIs/summaries and the outcomes of work done autonomously." (§7.6.)
- **D5 — Policy store: uniform schema-bounded rules + open `class` key + derived track record.** `keryx.policy.v1` per collector; rules share one shape and are scoped by an open `class` string, so new domains need no schema change. Track record is derived from the Kanban audit trail (cached, rebuildable). A free-text notes section is context only, never parsed (§7.7).
- **D6 — Judgment/execution separation: deterministic function + monitor agent on demand.** The disposition function decides the common case; a monitor sub-agent (via `delegate_task`) is invoked only for low-confidence + `external`/`irreversible` cards with no covering rule (§7.8).
- **D7 — Metrics: derive from Kanban.** Compute §11 metrics from state transitions and decision/dismissal/policy/regret comments; add only a thin read-side aggregator.
- **D8 — Phasing = confidence graduation, not a feature rollout.** The "phases" are the autonomy ladder a class climbs as track record accrues (cold → warming → trusted). Build-ordering is a separate, secondary concern. The absolute floor (money/destructive/credential) caps at *draft + approve* and never graduates to silent (§13).

---

## 7. Architecture changes

### 7.1 `keryx.action_item.v2` — classify by risk, derive confidence

`action_item.v1` remains readable via a migration shim (§12). New cards use `v2`. The single `autonomy` enum is removed. New / changed fields:

- `schema`: const `keryx.action_item.v2`.
- **`class`** (string, required) — an open, collector-defined key scoping the policy track record, e.g. `email:newsletter-unsubscribe`, `calendar:reschedule-reply`, `facebook:group-digest`. It scopes *which* confidence applies; it does **not** feed the disposition math. Free namespace → spans unforeseen domains.
- **`effort`** (enum, optional) — the old execution-effort hint `minimal`/`research`/`complex`, retained for worker planning and UI only. No authority semantics.
- **`urgency`** (unchanged), **`deadline`** (unchanged).
- **`proposed_disposition`** (enum, optional) — advisory `silent|review|interrupt`. The system may **downgrade** but never upgrades to silent/interrupt on a card's say-so.
- **`result_delivery`** (enum, optional, default `digest`) — for silent outcomes: `digest` (non-urgent, the default), `push` (the *result itself* is time-sensitive — e.g. "your flight is delayed"), or `log_only` (no proactive report; pull from the review log).
- **`digest_cadence`** (enum, optional, default `daily`) — `daily` or `weekly`; routes a silent outcome to the matching digest.
- **`digest_category`** (string, optional) — relevancy grouping label for the digest; defaults to the collector/source. Lets a monitor declare which section it belongs in (e.g. `Facebook`, `Sales`, `Weather`).
- **`default_on_timeout`** (object, required when disposition resolves to `interrupt`) — `{ action: "execute_option"|"dismiss", option_id?, after: <ISO-8601 duration or timestamp> }` (§10.6).
- Per option in `options[]`:
  - **`reversibility`** (enum, required) — an ordered spectrum of *commitment*: `read_only` (mutates no state at all — reads sources and produces only an outcome message to the user; nothing to undo) ⊂ `reversible` (mutates state the user can cheaply revert: delete the calendar block, discard the draft, ignore the notification) ⊂ `compensable` (cannot unsend, but a correction can follow) ⊂ `irreversible` (money out, public post, data deleted). A `read_only` option is the limit case: zero mutation, so the only cost is the user's attention.
  - **`blast_radius`** (enum, required) — `self` (effects confined to the user's own private domain; worst case is the user is bothered) or `external` (leaves that domain — messages to people, money, public record, others' systems). `read_only` reading that produces an externally observable signal — viewing a profile that records a visit, opening a message that fires a read-receipt, marking-as-read — is **not** `read_only`; it is at least `reversible` + `external`, because the act of reading left the user's domain.
  - **`undo_prompt`** (string, optional) — execution prompt for the reversal/correction when `reversibility ∈ {reversible, compensable}`; absent for `read_only` (nothing to undo) and `irreversible` (cannot undo).
  - **`absolute_floor`** (enum array, optional) — collector-flagged hard categories present in this option: any of `money`, `destructive`, `credential_gate`. Any value here forces the option to **never silent** regardless of the other axes; it caps at *draft + approve*.

**`confidence` is not a card field.** It is computed at decision time from the policy track record for `(collector, class)` (§7.7) and is therefore immune to collector manipulation or prompt injection.

Validator cross-checks (in `src/schemas/actionItem.ts`, beyond draft-07):

- An option with any `absolute_floor` value is recorded as floor-gated and cannot be silent-eligible.
- `read_only` requires `blast_radius = self` and no `absolute_floor` (a read that mutates nothing and emits no external signal cannot leave the user's domain or trip the floor). A collector that needs an external/observable read must declare `reversible`/`external` instead.
- `proposed_disposition = interrupt` requires `default_on_timeout` whose `option_id` (if `execute_option`) references a real option.
- `undo_prompt` is required when an option is `reversible` or `compensable`; absent for `read_only` and `irreversible`.

### 7.2 Disposition function

A pure module `src/policy/disposition.ts`. Inputs: the `action_item.v2` evidence + the looked-up `confidence` band for `(collector, class)` + the collector's approved `keryx.policy.v1` + global config defaults. Output: `{ disposition, tier, result_delivery, reasons[], requires_monitor }`.

It is driven by a **blast_radius × reversibility grid** (2 × 4, since `read_only` is the top of the reversibility spectrum), the confidence band, and urgency. The grid sets the **confidence required to run silently**:

| blast_radius × reversibility | confidence required for silent |
|---|---|
| self + read_only | none — silent by design (no state mutation; only the user's attention is spent) |
| self + reversible | warming |
| self + compensable | trusted |
| self + irreversible | trusted + explicit promotion |
| external + read_only | n/a — `read_only` is `self` by definition (an external/observable read is `reversible`/`external`) |
| external + reversible | trusted + explicit promotion |
| external + compensable | trusted + explicit promotion (high bar) |
| external + irreversible | trusted + explicit promotion (highest bar) |
| any option with `absolute_floor` (money/destructive/credential) | **never silent — caps at draft + approve** |

Decision order (first match wins; default is the most cautious):

1. **Absolute floor.** Any `absolute_floor` value, or any credential/2FA/CAPTCHA/payment gate → **review** or **interrupt**, never silent.
2. **Interrupt.** `urgency ∈ {urgent, soon}` and `blast_radius = external` (or an explicit interrupt rule) → **interrupt** (requires `default_on_timeout`). A `read_only` monitor whose *finding* is time-sensitive escalates here too: it exercises no authority, so over-escalating it is only a notification-spam risk (bounded by the interrupt budget), never a safety risk.
3. **Silent (read_only).** The selected option is `read_only` (hence `self`, no floor) → **silent**, `result_delivery` default `digest`. No policy rule required: no authority is exercised; only the user's own attention is spent, asynchronously.
4. **Silent (state-changing action).** The grid's confidence requirement for the executed option's cell is met by the looked-up band **and** an `active` policy rule authorizes silent for this `(collector, class)` within these axes → **silent**, `result_delivery` per card/policy (default `digest`).
5. **Default → review** (blocked; waits in the dashboard).

The function is deterministic, table-tested, and writes its `reasons[]` into the card's `policy_decision` comment so every disposition is auditable. This is the **judgment** component of the judgment/execution split (§7.8).

### 7.3 Confidence and the graduation ladder

**Confidence band** for `(collector, class)` is derived from the audit trail (§7.7): counts of approvals, **overrides** (user changed the recommended option), dismissals, and **regrets** (§7.9). Bands:

- **cold** — too few approvals to trust (e.g. < N, or any recent regret/override above threshold).
- **warming** — a positive record but below the silent bar; the collector should *draft/prepare* and offer *approve & send*.
- **trusted** — a strong record (≥ M approvals, override rate < X, no recent regret) **and** a human-approved promotion rule exists for the cell.

`read_only` monitor classes are exempt from the ladder: they are silent by design (§7.2 step 3), because reading state to produce a message for the user mutates nothing and exercises no authority.

The ladder (per state-changing `class`), matching D8:

1. **Cold →** card created `blocked`, no pre-work beyond classification, asks for a decision (pure review; waits in the dashboard).
2. **Warming →** collector performs the reversible prep (drafts the reply, stages the hold); card offers *approve & send*; still human-gated.
3. **Trusted →** disposition function returns silent for that cell; action runs autonomously and the outcome is reported in the digest/review log.

**Promotion is proposed, never self-taken.** When a class's derived track record crosses the trusted threshold, the worker/aggregator creates a **blocked promotion-suggestion card** ("I drafted 12 `email:newsletter-unsubscribe` replies you approved unchanged — promote this class to autonomous?"). Approving it writes an `active` rule (§7.7). This is the same human-approved mechanism as today's feedback-to-automation loop, now structured.

### 7.4 Silent execution path

A mutating command `hermes keryx auto-execute <card.json>` (and the internal path used by `create-card` when disposition resolves to silent):

- Writes a synthetic **`keryx.policy_decision.v1`** comment: `approved_by: "keryx-policy"`, `approved_via: "policy:<rule-id>"` (or `"policy:read-only"` for `read_only` monitor outputs), plus the disposition function `reasons[]`.
- Creates the card directly in `ready` (or create-then-promote, matching the existing sticky-block workaround for issue 39609).
- The updated worker treats a `policy_decision` comment as trusted **only** if it validates against `keryx.policy_decision.v1`, the selected option carries **no `absolute_floor` value**, and either the option is `read_only` or its risk axes match an `active` rule. Otherwise it blocks. The worker re-queries the source and re-checks the floor at execution time; for a `read_only` option it additionally verifies the executed plan performs no state mutation or external signal (§11).
- On completion the worker writes a structured **`keryx.outcome.v1`** comment (what was done, result summary, any changed source-system state, delivery channel) and the card lands in the **review log** (§7.10). The digest reads outcomes from these comments.

**Shadow mode (mandatory before any state-changing silent rule goes live, §10.1).** A rule may be `state: shadow` or `active`. In `shadow`, the disposition function computes "would have executed silently" and records it in the `policy_decision` comment, but the card is still created `blocked` for review. Promotion `shadow → active` is a human-approved policy change; the metrics surface (§7.9) reports **shadow agreement rate** so the user can judge stability before promoting. (`read_only` outputs do not require shadow, having no state mutation.)

### 7.5 Interrupt-now escalation and delivery (D2 = A)

**Escalation ladder (§10.5)** encoded as tiers, assigned by the disposition function:

1. Log only (silent → review log; `result_delivery: log_only`)
2. Digest of outcomes (silent → daily/weekly digest)
3. Async review queue (dashboard; review disposition)
4. Push notification (interrupt, normal)
5. Immediate interrupt (interrupt, urgent)
6. Stop and wait (blocked on missing authority)

**Delivery.** Keryx sends directly via a new allowlisted adapter shape `send <target> <message>` (§9). The target is the configured `notify_target` (chosen during setup). For an interrupt-tier card, Keryx composes a self-contained §9.2 message:

```
Urgent: <title>
Why: <one-line reason from policy_decision>
Risk if wrong: <risk>
Default if no reply by <time>: <default_on_timeout summary>
Open in Keryx: <deep link to /#/card/<id>>
Reply: approve / change / hold
```

- Sending appends a `keryx.notification.v1` comment (dedupe + audit) so a card is pushed once.
- **Rate limiting / budget / quiet hours** live in Keryx config: max interrupts per tier per day; a quiet-hours window during which only tier-5 immediate interrupts go out; everything suppressed falls back to the digest.
- **Expiring defaults.** A `keryx-default-resolver` step (a small scheduled job, or folded into the digest job) executes `default_on_timeout` when the deadline passes with no human decision, then records the auto-resolution (§10.6, prevents the "stuck for 119 minutes awaiting 15 seconds" failure, S14). Note `downgrade_to_batch` is removed — there is no batch queue; an unanswered interrupt either auto-executes its default option or is dismissed, and the outcome is reported in the next digest.

Because Keryx now sends, **`hermes send` is the one privilege added to the local server's reach**; it is a single fixed-arity allowlisted shape, callable only for interrupt-tier pushes and digest delivery, and covered by allowlist tests (§9, §11).

### 7.6 Result delivery and the digest (D4)

**There is no batch disposition, no `keryx:batch` tag, and no "Later" lane.** Pending decisions wait in the dashboard (the user pulls them on their own schedule). The digest exists only to **report the outcomes of work Keryx did autonomously**, so the user stays informed without polling.

**Silent outcomes are the unit; the digest is a read-side projection — it never executes, never waits, and never asks for decisions.**

- A silently-executed card carries a `keryx.outcome.v1` comment (§7.4) and a `result_delivery` of `digest` (default), `push`, or `log_only`.
- The repository-shipped `keryx-digest` job runs at configured cadences (daily and weekly) as a **read → compose → send**:
  1. Query silent outcomes since the last digest of this cadence (from `keryx.outcome.v1` comments), filtered to `result_delivery = digest` and `digest_cadence` matching.
  2. Group them by `digest_category` (default: collector/source), order categories by a configured relevancy priority, and within each category emit concise one-liners.
  3. Apply the brief discipline from `daily-brief`/`weekly-brief`: **omit empty categories; if nothing to report, send nothing** (`[SILENT]`).
  4. Compose one message, deliver via `hermes send` to `notify_target`, and mark each outcome digested (a per-cadence cursor or a `keryx.notification.v1`-style marker) so it is reported once.
- **`push` result delivery** bypasses the digest for the rare case where the *result itself* is time-sensitive (the action was safe and silent, but you need to know now); it reuses the §7.5 send path with a non-urgent framing.

Worked example (the user's case): a Facebook-group monitor and a sales/events/weather monitor are **`read_only`** collectors. Each tick they create silent `read_only` cards (`class: facebook:group-digest`, `digest_category: Facebook`, etc.); the worker reads the source and produces the summary as the outcome. Separately, the email collector silently unsubscribes from a newsletter (a graduated state-changing class) and records that outcome. At 8am the daily digest reads all outcomes since yesterday and emits one message:

```
📰 FACEBOOK
• <one line per relevant new post>
🏷 SALES & EVENTS
• <one line per relevant item>
🌤 WEATHER
• <only if a change worth noting>
🧹 DONE FOR YOU
• Unsubscribed from <newsletter> (reversible — undo in Keryx)
```

Categories with nothing to report are omitted; if every category is empty, no digest is sent. The user reads it passively; the underlying cards remain in the review log for audit/undo. The digest never blocks on a worker and never contains a "please approve" queue.

### 7.7 Policy / memory store (`keryx.policy.v1`) (D5)

Replaces editing automations into collector `SKILL.md` prose. One policy document per collector, stored in the collector's Hermes-space skill directory as `references/policy.json` (machine-read), with an optional `references/notes.md` (human context only).

**The schema constrains the *shape* of decisions, not the *space* of tasks.** Every rule shares one uniform form and is scoped by an **open `class` string**, so a new domain just adds keys — no schema change:

```jsonc
{
  "schema": "keryx.policy.v1",
  "collector": "keryx-email",
  "rules": [
    {
      "id": "r-001",
      "class": "email:newsletter-unsubscribe",
      "gate": { "max_blast_radius": "self", "min_reversibility": "reversible", "min_confidence": "trusted" },
      "disposition": "silent",
      "result_delivery": "digest",
      "state": "active",                // or "shadow"
      "approved_by": "User",
      "approved_at": "2026-06-25T09:00:00Z",
      "source_card_id": "keryx-123",
      "scope_note": "auto-handle one-click unsubscribes from known senders"
    }
  ],
  "thresholds": { "spend_requires_approval_always": true },
  "track_record": {                      // derived from the audit trail; cached, rebuildable
    "email:newsletter-unsubscribe": { "approved": 14, "overridden": 1, "dismissed": 2, "regret": 0, "band": "trusted", "updated_at": "..." }
  },
  "version": 3,
  "updated_at": "2026-06-25T09:00:00Z"
}
```

Rules of the road:

- **No rule is created or activated without a human-approved suggestion card.** This *extends* the existing worker feedback-to-automation loop: instead of proposing a prose `SKILL.md` edit, the worker proposes a structured `keryx.policy.v1` rule. Approving the card writes the rule.
- The disposition function reads only `rules`/`thresholds`/`track_record.band`. `notes.md`, `scope_note`, and `user_feedback` are untrusted-influenced prose, never parsed as machine instructions.
- **`track_record` is derived from Kanban** (decision/dismissal/regret comments), cached for speed and always rebuildable — so there is still no second database (keeps D7 honest). The aggregator (§7.9) recomputes bands and proposes promotions.
- New commands: `hermes keryx policy show <collector>`, `policy validate <file>`, `policy propose <file>` (creates the approval card); rules apply only through the normal execute-the-suggestion-card path.
- Rules are inspectable and revocable from the UI Policy panel (revoke writes an auditable change).

### 7.8 Judgment / execution separation (D6)

- **Default (deterministic):** §7.2 disposition function is the judgment layer; the worker is the execution layer. They are already separate modules and separate Kanban phases (decision comment vs. dispatch).
- **Escalation (agentic):** when the function returns `requires_monitor = true` (cold/warming confidence + `external` or `irreversible` + no covering rule), the collector spawns a **monitor sub-agent** via `delegate_task` whose sole job is "should this be escalated, and at what tier?" — it cannot execute side effects. Its verdict is written into the card evidence and feeds the next disposition pass. Mirrors "Ask or Assume?" monitor/executor separation (S8); agent cost is confined to genuinely ambiguous cases.

### 7.9 Metrics (§11, D7)

A read-side aggregator `hermes keryx metrics [--window <range>] [--json]` derives §11 metrics from Kanban state + Keryx comments, with **no new persistent store**:

- **Autonomous safe completion rate** — silent executions reaching the review log without undo/correction.
- **Interruption precision / recall** — interrupts approved vs. dismissed; consequential cards surfaced in time (deadline-met proxy).
- **Ask-F1** — harmonic mean of question precision and blocker recall.
- **Approval latency** — interrupt-comment → decision-comment.
- **Escalation regret** — one-click UI signal writing a `keryx.regret.v1` comment ("should have acted" / "should have asked"); feeds confidence bands.
- **Recovery cost** — undo/correction cards after silent executions.
- **Attention burden** — interrupts/day by tier (also the notifier budget).
- **Digest compression** — raw monitored items folded into one digest.
- **Policy coverage / override rate / shadow agreement rate** — promotion-readiness signals.
- **Silent failure count** — highest severity; surfaced prominently.

Metrics appear in the digest and a UI Metrics panel. They are advisory except shadow-agreement and track-record bands, which gate (but do not auto-perform) promotions.

### 7.10 Completed-as-review-log and lifecycle changes

- **Completed** becomes a **Review log**: `done` cards plus whether each was human-approved or silently executed (from the decision comment's `approved_via`) and the `keryx.outcome.v1` result, with **Archive** (read-and-dismiss, sets `keryx:reviewed`) and **Undo/Correct** (§7.4).
- New contracts close the validation gaps: **`schemas/dismissal-decision.v1.schema.json`** + `hermes keryx validate-dismissal`; and `keryx.policy_decision.v1`, `keryx.outcome.v1`, `keryx.notification.v1`, `keryx.regret.v1` so every machine-written comment is validated.

---

## 8. Schema specifications (canonical contracts)

New / changed schema files under `schemas/`, each with a matching `src/schemas/*.ts` validator and `hermes keryx schema <name>` output:

1. `action-item.v2.schema.json` — §7.1. Removes `autonomy`; adds `class`, optional `effort`, `proposed_disposition` (`silent|review|interrupt`), `result_delivery`, `digest_cadence`, `digest_category`, `default_on_timeout`; option-level `reversibility` (`read_only`/`reversible`/`compensable`/`irreversible`), `blast_radius`, `undo_prompt`, `absolute_floor`. No `confidence` field (derived). Cross-validations per §7.1.
2. `dismissal-decision.v1.schema.json` — formalizes the body `commands.ts#buildDismissalDecision` already emits.
3. `policy-decision.v1.schema.json` — synthetic trusted decision for silent execution; `approved_by` constrained to non-human policy identities; carries `rule_id` and `reasons[]`.
4. `outcome.v1.schema.json` — structured silent-execution outcome the digest reads (compact result summary, delivery channel, changed source-system state; no raw bodies).
5. `policy.v1.schema.json` — §7.7 uniform rule store with open `class` keys and derived `track_record`.
6. `notification.v1.schema.json` and `regret.v1.schema.json` — interrupt/digest dedupe + audit and escalation-regret signal.
7. `collector-state.v1` — extend additively with optional `executed_external_ids` so silent execution participates in cursor-safety/idempotency the same way carding/dismissal do ("handled = executed silently").

All schemas keep `additionalProperties: false`, ISO-8601 timestamp patterns, and existing idempotency-key conventions.

---

## 9. Adapter, opsctl, API, config, and UI changes

**Adapter (`src/hermes/adapter.ts`)** — keep allowlisted:
- Card creation gains a `ready`-or-`blocked` branch driven by resolved disposition (reusing the sticky-block workaround for issue 39609 where blocked-then-promote is needed).
- Lane/state tags (`keryx:reviewed`): prefer deriving review-log/lane state in the read layer from body/comments to avoid widening the allowlist; add a tag shape only if Kanban requires it (confirm in build-step 1).
- **New: `send <target> <message>`** — a single fixed-arity allowlisted shape, used only for interrupt pushes and digest delivery, with dedicated allowlist tests.

**Config (`src/config.ts`, `keryx.config.json`)** — add `notify_target` (default delivery target), digest cadences/times, relevancy-category ordering, and interrupt budget/quiet-hours fields. `keryx.config.example.json` updated.

**Setup (`keryx-setup.sh`)** — add a step that runs `hermes send --list`, lets the operator choose a default target (e.g. telegram/discord), and writes `notify_target`. Dry-run describes it; no real cron/board/send side effects.

**opsctl / `hermes keryx`** — add: `auto-execute`, `undo`, `policy show|validate|propose`, `validate-dismissal`, `metrics`, `digest --preview` (renders the next digest without sending). Output stays stable and concise (tests assert exact phrases).

**API (`src/server/routes.ts`)** — add read routes for the review log, policy list, metrics, and digest preview; mutating routes for `undo`, `mark-reviewed`, `policy revoke`, regret. All delegate to the centralized command logic, preserving the §3.2 single-mutation-path rule and existing task-id guards.

**UI (`src/web/`)** — reframe from "polling inbox" to "decision + audit surface":
- Lanes: **Needs you** (review/interrupt blocked — the pull-queue the user sweeps at will), **Review log** (silent + done, with outcome, Archive/Undo), **Running**, **Dismissed**. No "Later" lane.
- The **Needs you** lane keeps and strengthens the existing urgency filter/sort so the user can batch-attend low-urgency decisions on their own schedule (this is Keryx's "batch later for decisions").
- Card surfaces the new evidence (reversibility incl. `read_only`, blast_radius, derived confidence band, default-on-timeout) and, for silent cards, the policy reason that authorized them and the recorded outcome.
- New **Policy** panel (list/inspect/revoke rules, shadow vs. active, derived track record), **Metrics** panel, and a **Digest preview**.
- The dashboard stops being the notification mechanism; an in-app note states outcomes arrive via the `<notify_target>` digest and interrupts via push. Polling remains only for these views.

---

## 10. Skills and collector changes

- **`keryx:keryx-worker`** — (a) accept a validated `keryx.policy_decision.v1` comment as trusted for non-floor options that are either `read_only` or whose risk axes match an `active` rule, re-checking the floor after re-querying the source and verifying a `read_only` plan mutates no state and emits no external signal; (b) write a `keryx.outcome.v1` comment and route completions to the review log; (c) propose automations as structured `keryx.policy.v1` rule cards (replacing prose-edit suggestions), and propose **promotion** cards when a class's track record crosses the trusted threshold — both human-approved.
- **`keryx:keryx-collector`** — populate v2 evidence per option (`reversibility` incl. `read_only`, `blast_radius`, `class`, optional `effort`); set a conservative `proposed_disposition` and, for monitors, `result_delivery`/`digest_category`/`digest_cadence`; do warming-stage reversible prep (drafts/holds) when confidence warrants; extend cursor-safety so "handled" includes "executed silently" only after the action is durably recorded and idempotent.
- **`keryx:keryx-collector-creator`** — add steps for: defining the `class` namespace for the source; distinguishing **`read_only` monitor** collectors (silent-by-design, digest-routed) from **state-changing action** collectors (graduation ladder); choosing which cells are *eligible* to ever graduate (and which are absolute-floor, capped at draft+approve); authoring the `keryx.policy.v1` skeleton in `shadow`; setting digest category/cadence; wiring `keryx-digest` (and `keryx-default-resolver` if used); documenting `notify_target` usage.
- **Templates / docs** — update `cron-prompt.md` files, `docs/architecture.md`, `docs/operations.md`, `docs/collector-authoring.md`, `docs/security.md`, `README.md`, and `AGENTS.md` for the new lifecycle, three dispositions + digest, risk axes (incl. `read_only`), monitor outputs, policy store, `hermes send`, and the §11 trust rules. `AGENTS.md` safety boundaries must change in the same commit (its own rule).

---

## 11. Security model updates (the central problem of v005)

Silent execution moves the trust boundary; v005 makes the new boundary explicit and defensible:

1. **Policy is the trust gate for state-changing silent actions, and policy is human-approved.** No state-changing silent execution without an `active` `keryx.policy.v1` rule a human approved via a suggestion card. Collectors and source content can *propose* but never *grant* autonomy. `proposed_disposition` is advisory and only ever downgraded by the system.
2. **`read_only` outputs are silent without a rule, because they mutate nothing and exercise no authority.** A `read_only` option performs no state mutation and emits no external signal (`self`, no `absolute_floor`); the worst case is digest noise. The worker enforces this — an option claiming `read_only` while attempting any mutation or externally observable read blocks.
3. **Confidence is derived from the user's history, not declared.** Because the collector reasons over untrusted source content, it must not assert its own trustworthiness; track record is computed from the user's own approvals/overrides/regrets, so injection cannot manufacture confidence.
4. **Schema-bounded policy.** The disposition function reads only validated structured fields. Free-text notes/feedback/scope are never parsed as instructions.
5. **Absolute floor that no rule can lower.** **Money/payments, destructive data loss, and credential/2FA/CAPTCHA gates are never silent** — they cap at *draft + approve* — regardless of axes, confidence, or rules. Enforced in the validator (option `absolute_floor`), the disposition function, and again by the worker at execution time.
6. **Elevated bar, not a ban, for external/irreversible.** External communication and hard-to-reverse actions can graduate to silent, but only with `trusted` confidence **and** an explicit human-approved promotion for that exact cell — never automatically.
7. **Re-check at execution.** The worker re-validates the trusted decision and re-queries the source before any side effect; a `policy_decision` that no longer matches blocks rather than executes.
8. **Reversible-first margin.** The grid demands far more confidence as reversibility and blast radius worsen, bounding the cost of silent confident wrongness (§12.1).
9. **Shadow before active** for state-changing rules; promotion is a human decision informed by shadow-agreement metrics.
10. **No raw persistence anywhere new.** Policy, outcomes, metrics, notifications, and digests store only compact facts, IDs, summaries, and rule references. Deep links point back to Keryx and embed no private payload; the digest follows the brief discipline of compact one-liners, not raw source bodies.
11. **Auditability.** Every silent action, outcome, notification, auto-resolution, regret, and policy change writes a validated comment; the Kanban trail stays the complete audit log.
12. **`hermes send` is the single new privilege.** It is a fixed-arity allowlisted shape used only for interrupt/digest delivery; the web server keeps its `127.0.0.1` bind and host-header allowlist, so outbound delivery opens no inbound surface.

Threat-model additions for `docs/security.md`: injection attempting to (a) set `proposed_disposition: silent`, (b) claim `read_only` while mutating state or performing an externally observable read, (c) understate `reversibility`/`blast_radius`, (d) mislabel an `absolute_floor` action as benign, or (e) smuggle instructions via notes/feedback — each defeated by points 1–7.

---

## 12. Migration and backward compatibility

- **`action_item.v1` stays readable.** A shim maps v1 → v2: `autonomy` → `effort` verbatim; per option `reversibility: irreversible`, `blast_radius: external`, no `class` (defaults to a generic per-collector bucket with `cold` confidence). Net effect: **all existing v1 cards resolve to `review`** — current behaviour preserved exactly until rules are authored. (The shim never infers `read_only`; a monitor must be re-authored as v2 to earn silent-by-design treatment.)
- Collectors are updated to emit v2; v1 emission deprecated but tolerated one release.
- New comment schemas are additive; `execution_decision.v1`/`dismissal_decision.v1` keep working, with `dismissal_decision` now validated.
- Default config ships with **no active rules, empty interrupt budget, and a digest that is silent until silent outcomes exist**, so an upgraded install behaves like v004 until the user opts classes into warming/silent/interrupt or adds a monitor collector.

---

## 13. Phasing as confidence graduation (D8)

The phases are the **autonomy ladder a class climbs**, not a feature rollout. For any state-changing `(collector, class)`:

- **Cold.** No track record → card created `blocked`, no pre-work beyond classification, asks for a decision in the dashboard. (Every state-changing class starts here; every v1 card sits here after migration.)
- **Warming.** Positive track record below the silent bar → the collector does the reversible prep (drafts the reply, stages the hold) and the card offers *approve & send*. The user is still the gate, but the work is pre-done.
- **Trusted.** Strong track record **and** an approved promotion for the cell → the disposition function returns silent; the action runs autonomously and the outcome is reported in the digest/review log.
- **Capped (absolute floor).** Money/destructive/credential classes never leave *warming* — they can be drafted and queued for one-click approval but never graduate to silent.
- **Informational classes** skip the ladder entirely — silent by design, digest-reported — because they exercise no authority.

A class moves up only when the system *proposes* promotion (track record crossed a threshold) and the user approves; it moves down automatically when regrets/overrides degrade the band (a `trusted` class that starts producing corrections demotes to `warming` and its `active` rule reverts to `shadow`, surfaced in the digest).

**Build-ordering (secondary, engineering concern).** The runtime ladder needs machinery in roughly this order, but this is implementation sequencing, not the product model: (1) `action_item.v2` + disposition function + new comment schemas (behaviour-neutral; everything resolves to review); (2) `read_only` silent path + `keryx-digest` + outcomes + relevancy categories; (3) policy store + track-record aggregator + shadow mode + metrics; (4) warming-stage drafting in collectors; (5) state-changing silent path + review log + undo; (6) `hermes send` + interrupt ladder + expiring defaults; (7) monitor sub-agent + promotion/demotion proposals. Each is independently shippable, keeps blocked-by-default as the fallback, and does not regress the local-only posture.

---

## 14. Testing requirements

Add/extend tests beside the behaviour they cover; fakes and temp `HERMES_HOME` only (no real Hermes home, board, cron, or delivery).

- **Schema/unit:** v2 cross-validations (`absolute_floor` gating, `read_only` constraints, `default_on_timeout` references, `undo_prompt` presence); new comment/policy/outcome schemas; disposition-function decision table — every grid cell × confidence band × urgency, including `read_only` silent, floor overrides, and shadow vs. active; confidence-band derivation from a fixture audit trail.
- **Adapter allowlist:** the create `ready`/`blocked` branch; the new `send` shape accepted only in its exact fixed-arity form and rejected for any other use.
- **opsctl/integration:** `auto-execute`, `undo` (all three reversibility paths), `policy propose/show/validate/revoke`, `validate-dismissal`, `metrics`, `digest --preview`; idempotency — a silently-executed card that re-runs must not double-act; setup-script `notify_target` selection against a fake `send --list`.
- **Digest:** read-only over `keryx.outcome.v1` comments; categorizes by relevancy; omits empty categories; emits nothing when there is nothing to report; marks outcomes digested once; never waits on a worker; never includes a pending-decision queue.
- **Security:** injection attempts that set `proposed_disposition: silent`, claim `read_only` while mutating state or performing an externally observable read, understate risk axes, mislabel `absolute_floor`, or embed instructions in notes — assert none reach silent/interrupt, and confidence cannot be inflated via card fields.
- **API/UI:** new routes; review-log Archive/Undo and outcome display; Policy, Metrics, and Digest-preview panels; absence of a Later lane; e2e for the review log and an interrupt-tier card's deep link.
- **Migration:** v1 cards resolve to `review`; default config performs no silent/interrupt action and sends no digest until outcomes exist.
- **Jobs:** `keryx-digest`/`keryx-default-resolver` dry-run against fixtures; no real cron creation; dedupe via `notification.v1`/digest cursor.

Run `npm run lint` and `npm test` minimum; `npm run typecheck` for UI/shared-type changes; `npm run build` for server-entry changes; `npm run e2e` for inbox behaviour.

---

## 15. Success criteria

- An upgraded install with no policy rules behaves exactly as v004 (review-only), proving safe-by-default migration.
- A state-changing class visibly climbs the ladder: cold (ask) → warming (draft + approve) → trusted (autonomous), with each promotion proposed by the system and approved by the user, and demotion on regret.
- A `read_only` monitor collector runs silently from day one and its outputs appear only in the digest — never as a decision to approve.
- No silent path is reachable for money, destructive, or credential-gated actions under any card claim or rule; external/irreversible actions reach silent only via explicit promotion at `trusted` confidence.
- The daily/weekly digest reports autonomous outcomes grouped by relevancy, omits empty categories, sends nothing when there is nothing to report, and never waits on execution or asks for approvals.
- Pending decisions appear only in the dashboard, where the user sweeps low-urgency items on their own schedule; nothing pushes a queue of decisions at them.
- A genuinely urgent, consequential card pushes a single self-contained interrupt to `notify_target` with a deep link and an expiring default.
- §11 metrics are visible and derived entirely from Kanban state — no second store.

## 16. Open questions and risks

1. **Subjective interruption cost** (§15 q1): coarse quiet-hours + tier budgets only; per-user/time-of-day modelling deferred.
2. **Band thresholds** (N approvals, M for trusted, override/regret limits): start conservative and tune from metrics; exact numbers are config, not schema.
3. **Mis-declared risk axes:** a collector could under-state `reversibility`/`blast_radius` or claim `read_only` for something that mutates state. Mitigated by the worker's execution-time floor + `read_only` (no-mutation, no-external-signal) re-check, conservative migration defaults, and demotion on regret; revisit if recovery-cost metrics rise.
4. **Social irreversibility** (§2): `compensable` is honest about issuing a correction, never an "unsend"; UI copy must not imply otherwise.
5. **Multi-assistant coordination** (§15 q5): out of scope; if other Hermes agents also push, the user could be double-notified.
6. **Read-layer vs. tag-driven state:** PRD prefers deriving review-log/lane state in the read layer to avoid widening the allowlist; confirm Kanban tag support in build-step 1.
7. **Send reliability:** a failed `hermes send` must not silently drop an interrupt or a digest; the metrics surface reports "interrupts/digests pending vs. sent," and a missed delivery is a tracked silent-failure metric.
8. **Optional review footer in the digest:** the user does not want a pushed decision queue, so the digest reports outcomes only. A one-line "N items await review in Keryx" footer is available as an explicit opt-in config, off by default.
9. **Digest cadence overlap:** an outcome routed to both daily and weekly must be reported once per cadence without duplication across cadences; the per-cadence cursor handles this and is covered by tests.

## 17. Out of scope (restated)

User-configured rules engine; model-tool exposure; non-localhost server exposure or built-in auth; biometric/sensor attention modelling; true unsend of socially irreversible actions; a pushed queue of pending decisions; multi-assistant coordination; any real cron/board/Hermes-home/send mutation in tests.
