# Keryx architecture

Keryx is a thin control surface over Hermes Kanban. It adds canonical schemas, a Hermes plugin named `keryx`, the `hermes keryx ...` command surface, a safe `./bin/opsctl` fallback, a local Fastify API, and a Svelte inbox UI. It does not create a second task database.

v005 makes Keryx an **attention-allocation surface**: rather than funnelling every candidate action through one approval queue, it assigns each card a **disposition** — act silently, prepare for review, or interrupt now — and reports the outcomes of silent work through a non-urgent digest.

## Central register

Kanban is the central register. Collectors, the web UI, `hermes keryx`, `opsctl`, the disposition function, and workers all converge on the same board and task lifecycle. This keeps the source of truth auditable and lets normal Hermes dispatch semantics remain in charge of execution. There is no second store: dispositions, the review log, policy track record, and metrics are all derived from card status, bodies, and comments.

## Hermes plugin boundary

The Keryx plugin is the Hermes-facing adapter. It registers the `hermes keryx ...` CLI command and repository-backed Keryx skills, then delegates behaviour to repository code. Keryx schemas, skills, config, UI, and command logic remain in this repository.

Repository skills are explicit plugin-qualified loads:

```text
keryx:keryx-worker
keryx:keryx-collector
keryx:keryx-collector-creator
```

## The three dispositions

Every actionable card resolves to exactly one **disposition**, derived by a deterministic function (`src/policy/disposition.ts`) from each option's risk axes (`reversibility`, `blast_radius`, any `absolute_floor`), the user's derived **confidence** band for the card's `(collector, class)`, urgency, and the collector's human-approved policy. The disposition is never declared by the card or by source content — a card may carry an advisory `proposed_disposition`, but the system can only downgrade it, never upgrade to silent or interrupt.

- **Silent** — the class has graduated and a human-approved policy rule covers the option, or the option is `read_only` (silent by design, since it mutates nothing). The card is created `ready` with a synthetic `keryx.policy_decision.v1` comment; a worker executes and writes a structured `keryx.outcome.v1` comment; the card lands in the **review log**. Outcomes are reported non-urgently through the digest by default (`push` only when the result itself is time-sensitive; `log_only` to pull from the review log).
- **Review** (the default fallback) — draft, gather, or propose without committing. The card is created `blocked` and the user approves an option in the dashboard on their own schedule. Any card whose evidence does not clearly justify silent or interrupt falls back here.
- **Interrupt** — urgent and consequential, where delay or a wrong action is costly. The card is created `blocked` and flagged for interrupt; Keryx pushes a self-contained message (recommendation, risk, expiring default, deep link) via `hermes send` and the card carries a `default_on_timeout` that resolves it deterministically if unanswered.

Silent is never reachable for a state-changing class without an explicit, human-approved policy rule, and never at all for the absolute-floor categories (money, destructive, credential/2FA/CAPTCHA gates), which cap at draft + approve.

## Lifecycle mapping

- `blocked`: visible in Keryx as waiting for operator approval (review) or carrying an interrupt push.
- `ready`: approved (or silent-authorized by policy) and eligible for Hermes dispatch.
- `running`: claimed by a worker.
- `done`: completed by the worker, recorded with a `keryx.outcome.v1` comment, and shown in the **review log**.
- `archived`: dismissed, undone, or read-and-cleared from the review log.

Keryx should show malformed card bodies rather than hiding them. A malformed card is still a board item and may need repair.

## Collector flow

Collectors inspect sources and create cards only for actionable items. Card bodies are structured as `keryx.action_item.v2`; source content is untrusted and should be reduced to compact facts, references, and per-option risk evidence (`reversibility`, `blast_radius`, optional `absolute_floor`) plus an open `class` key. The collector classifies honestly; the disposition function — not the collector — decides whether a card runs silently, waits for review, or interrupts.

Collector authors use the canonical card workflow rather than hand-maintained templates:

```sh
hermes keryx template-card --source <source> --collector <collector> > /tmp/keryx-card.json
# fill compact candidate facts, the class key, and per-option risk axes
hermes keryx schema action-item   # if field semantics are uncertain
hermes keryx validate-card /tmp/keryx-card.json
hermes keryx create-card /tmp/keryx-card.json
rm -f /tmp/keryx-card.json
```

`hermes keryx create-card` centralises board selection, schema validation, the disposition decision (silent cards land `ready` with a `keryx.policy_decision.v1` comment; review/interrupt cards land `blocked`), assignee/tenant/idempotency policy, and worker attachment with `keryx:keryx-worker`. Collectors do not execute source actions themselves. Their job is discovery, honest risk classification, safe card creation, and cursor handling.

## Decision, execution, and the review log

On the review path, `hermes keryx execute` records a trusted `keryx.execution_decision.v1` comment with the selected option and optional feedback (the direct repository fallback is `./bin/opsctl execute`); on the silent path, `create-card`/`auto-execute` writes a synthetic `keryx.policy_decision.v1` comment. Both promote the card to `ready` when promotion is appropriate.

Workers read the card, find the latest trusted decision (human execution decision or synthetic policy decision), validate the selected option, re-query source systems when needed, perform only the approved action, and complete the task with a `keryx.outcome.v1` comment. Completed cards form the **review log**, which supports archive-after-read and an honest `hermes keryx undo` / correct path keyed off the executed option's reversibility.

## UI/API boundary

The Fastify API exposes a narrow set of polling-friendly routes for the Svelte UI. Mutating routes delegate to the same command logic as `hermes keryx`/`opsctl`, so command construction and Kanban mutation rules remain centralised. The dashboard is where the user pulls and works review items on their own schedule; the digest and interrupt push report outcomes and urgent decisions without requiring the user to poll the board.

The web UI binds to `127.0.0.1` by default and has no built-in authentication. Interrupt and digest delivery go outbound through `hermes send` and do not open an inbound surface. If the dashboard is exposed beyond localhost, authentication belongs in an external layer such as a reverse proxy or private network.
